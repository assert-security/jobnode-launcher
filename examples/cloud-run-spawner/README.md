# Google Cloud Run + GKE Spawner

The GCP-native shape of the launcher: host the launcher service on **Cloud Run**, spawn workers as pods in **GKE**.

This example covers two pieces:

1. **Hosting** — taking the reference TypeScript implementation and deploying it to Cloud Run instead of AWS Lambda. The protocol code in `reference-lambda/src/` is mostly portable; only the entrypoint shape differs.
2. **Spawning** — replacing the in-memory stub with calls to the GKE API. Reuses the `K8sSpawner` from [`../k8s-spawner/k8s-spawner.ts`](../k8s-spawner/k8s-spawner.ts) — Kubernetes is Kubernetes everywhere.

You can also run the launcher entirely outside GKE (in Cloud Run) while the workers live in GKE; the `kubeconfigYaml` option on `K8sSpawner` is how the launcher reaches the cluster.

---

## Architecture

```
┌─────────────────┐  HTTPS  ┌────────────────┐  k8s API  ┌────────────────┐
│ Assert Security │────────▶│ Cloud Run      │──────────▶│ GKE Autopilot/ │
│ job-scaler      │         │ (launcher)     │           │ Standard       │
└─────────────────┘         └────────┬───────┘           │  (workers)     │
                                     │                   └────────────────┘
                            ┌────────▼──────────┐
                            │ Secret Manager    │
                            │ (bearer token,    │
                            │  worker client    │
                            │  secret)          │
                            └───────────────────┘
```

Idempotency dedupe options on GCP:

- **In-memory** — fine for a single-instance Cloud Run service (`max-instances: 1`)
- **Firestore** — equivalent to the reference's DynamoDB-with-TTL pattern
- **Memorystore Redis** — if you already run it

This example uses Firestore (managed, server-less, free tier covers a launcher's load profile).

---

## Files

| Path | Purpose |
|---|---|
| `server.ts` | Express adapter — wraps the protocol handler in a Cloud Run-friendly entrypoint. |
| `firestore-idempotency.ts` | Drop-in `IdempotencyStore` implementation backed by Firestore. |
| `Dockerfile` | Containerises the launcher for Cloud Run. |
| `service.yaml` | Cloud Run service manifest. |
| `deploy.sh` | Reference build + push + deploy script. |

For the worker side, point at the same `manifests/` folder in [`../k8s-spawner/`](../k8s-spawner/) — the worker Deployment manifest is identical between GKE and any other k8s.

---

## Deploy

Prereqs:

- `gcloud` CLI authenticated against your project
- A GCP project with Cloud Run, Cloud Build, Artifact Registry, Firestore, Secret Manager APIs enabled
- A GKE cluster (Autopilot or Standard) where the worker Deployment will live
- The four worker env-var values (master URL, OAuth client id, secret, scope) from your Assert Security operator
- A bearer token from your Assert Security operator, stored in Secret Manager:
  ```bash
  echo -n "$BEARER_TOKEN" | gcloud secrets create asserts-launcher-token --data-file=-
  ```

Then:

```bash
export GCP_PROJECT="your-project"
export GCP_REGION="us-central1"
export GKE_CLUSTER="your-cluster"
export GKE_LOCATION="us-central1"
export TENANT_SLUG="acme-corp"
export GROUP_NAME="ACME Internal"

bash deploy.sh
```

The script outputs the Cloud Run service URL — hand it to your Assert Security operator.

---

## Notes on Cloud Run specifics

- **Cold starts.** Cloud Run gen2 cold start is ~1–2s for a typed Node.js service. Well within the protocol's 2s `/health` budget. If you set `min-instances: 1` you eliminate cold starts entirely.
- **Concurrency.** Default 80 concurrent requests per instance is fine — the launcher's surface is read-mostly + bounded write. The Firestore idempotency store is concurrency-safe.
- **TLS.** Cloud Run provides a valid HTTPS endpoint out of the box (`*.run.app`). Bring your own domain if you prefer.
- **IAM.** The Cloud Run service account needs `roles/datastore.user` for Firestore, `roles/secretmanager.secretAccessor` for the bearer token, and `roles/container.developer` if it talks directly to GKE. The deploy script wires these.
- **Auth.** This service authenticates the *caller* via the protocol's Bearer token — not via IAM. Set the Cloud Run service to allow unauthenticated invocations; the Bearer check inside the handler is the security boundary. (Alternatively front it with Cloud Endpoints + an API key, and stack that on top of the Bearer check.)

---

## Why this isn't the reference

The reference lives on AWS Lambda because Assert Security itself is AWS-hosted and that's the deployment shape we exercise daily. Functionally the Cloud Run + Firestore + GKE shape is equivalent — same protocol, same code structure, swap a few SDK calls. Choose whichever cloud you already operate.
