#!/usr/bin/env bash
# Reference deploy script for the Cloud Run launcher.
#
# Required env vars:
#   GCP_PROJECT      — your GCP project ID
#   GCP_REGION       — Cloud Run region, e.g. us-central1
#   TENANT_SLUG      — your Assert tenant slug
#   GROUP_NAME       — the Assert worker-group name
#
# Optional env vars:
#   IMAGE_REPO       — Artifact Registry repo path (default: asserts-launcher)
#   SERVICE_NAME     — Cloud Run service name (default: asserts-launcher)
#   SPAWNER_MAX_WORKERS / SPAWNER_MIN_WORKERS — limits, defaults 8 / 0
#
# Prerequisites (run once per project):
#   gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
#                          artifactregistry.googleapis.com firestore.googleapis.com \
#                          secretmanager.googleapis.com
#   echo -n "$BEARER_TOKEN" | gcloud secrets create asserts-launcher-token --data-file=-
#   gcloud artifacts repositories create asserts-launcher \
#       --repository-format=docker --location="$GCP_REGION"
#   gcloud firestore databases create --location="$GCP_REGION"

set -euo pipefail

: "${GCP_PROJECT:?must be set}"
: "${GCP_REGION:?must be set}"
: "${TENANT_SLUG:?must be set}"
: "${GROUP_NAME:?must be set}"

IMAGE_REPO="${IMAGE_REPO:-asserts-launcher}"
SERVICE_NAME="${SERVICE_NAME:-asserts-launcher}"
SPAWNER_MAX_WORKERS="${SPAWNER_MAX_WORKERS:-8}"
SPAWNER_MIN_WORKERS="${SPAWNER_MIN_WORKERS:-0}"

IMAGE="${GCP_REGION}-docker.pkg.dev/${GCP_PROJECT}/${IMAGE_REPO}/launcher:$(date +%Y%m%d-%H%M%S)"
RUNTIME_SA="asserts-launcher-runtime@${GCP_PROJECT}.iam.gserviceaccount.com"

echo "==> Ensuring runtime service account exists: $RUNTIME_SA"
if ! gcloud iam service-accounts describe "$RUNTIME_SA" --project="$GCP_PROJECT" >/dev/null 2>&1; then
    gcloud iam service-accounts create asserts-launcher-runtime \
        --project="$GCP_PROJECT" \
        --display-name="Assert launcher runtime"
fi

echo "==> Granting required IAM roles"
for role in roles/datastore.user roles/secretmanager.secretAccessor; do
    gcloud projects add-iam-policy-binding "$GCP_PROJECT" \
        --member="serviceAccount:${RUNTIME_SA}" \
        --role="$role" \
        --condition=None \
        --quiet >/dev/null
done

echo "==> Building image with Cloud Build: $IMAGE"
gcloud builds submit \
    --tag="$IMAGE" \
    --project="$GCP_PROJECT" \
    .

echo "==> Deploying Cloud Run service: $SERVICE_NAME"
gcloud run deploy "$SERVICE_NAME" \
    --project="$GCP_PROJECT" \
    --region="$GCP_REGION" \
    --image="$IMAGE" \
    --service-account="$RUNTIME_SA" \
    --allow-unauthenticated \
    --min-instances=1 \
    --max-instances=3 \
    --concurrency=80 \
    --timeout=15s \
    --cpu=1 \
    --memory=512Mi \
    --set-env-vars="LAUNCHER_TENANT_SLUG=${TENANT_SLUG},LAUNCHER_GROUP_NAME=${GROUP_NAME},SPAWNER_MAX_WORKERS=${SPAWNER_MAX_WORKERS},SPAWNER_MIN_WORKERS=${SPAWNER_MIN_WORKERS}" \
    --set-secrets="LAUNCHER_BEARER_TOKEN=asserts-launcher-token:latest"

URL=$(gcloud run services describe "$SERVICE_NAME" \
    --project="$GCP_PROJECT" --region="$GCP_REGION" \
    --format='value(status.url)')

echo
echo "==> Done. Hand this URL to your Assert operator: $URL"
echo "    Health probe:  curl -H 'Authorization: Bearer <token>' $URL/health"
