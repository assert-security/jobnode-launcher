# Kubernetes Spawner Adapter

A cloud-neutral implementation of the `Spawner` interface from [`../../reference-lambda/src/spawner.ts`](../../reference-lambda/src/spawner.ts) that spawns Venari job-node workers as pods in a Kubernetes Deployment.

Works unchanged on:

- **GKE** (Google Kubernetes Engine)
- **EKS** (AWS)
- **AKS** (Azure)
- **OpenShift** (any flavour)
- **k3s / kind / minikube** for dev
- **Rancher, Tanzu**, anything else conformant

The only k8s-specific decision is how the launcher *itself* authenticates to the cluster. Two patterns are covered below: in-cluster (launcher pod uses a ServiceAccount) and out-of-cluster (launcher reads a kubeconfig).

---

## What this adapter does

When `launch(deltaCount)` is called, the adapter increments the `replicas` field on a target Deployment by `deltaCount`. When `terminate(workerId)` is called, it deletes the pod by name; the Deployment's controller automatically reconciles down. Worker IDs are pod names.

The adapter does NOT manage:

- The Deployment itself — you create that once (manifest in [`manifests/job-node-deployment.yaml`](manifests/job-node-deployment.yaml))
- The Secret holding `node__authinfo__clientsecret` — you create that once and reference it from the Deployment

---

## Install

This adapter is a reference *for the spawner step only*. You still deploy the reference Launcher itself; only `src/spawner.ts` is swapped.

### Option A — launcher is itself a pod in the cluster

The most common shape: the launcher and the workers live in the same cluster, the launcher's pod has a ServiceAccount with permission to scale the worker Deployment and delete its pods.

1. Apply the base manifests:
   ```bash
   kubectl apply -f manifests/namespace.yaml
   kubectl apply -f manifests/launcher-serviceaccount.yaml
   kubectl apply -f manifests/launcher-rbac.yaml
   kubectl apply -f manifests/job-node-deployment.yaml
   ```
2. Swap the k8s spawner into the reference launcher and add the k8s client dependency. The `sed` rewrites the relative import prefix so it resolves from `src/`:
   ```bash
   cp k8s-spawner.ts ../../reference-lambda/src/spawner.ts
   sed -i 's#\.\./\.\./reference-lambda/src/#./#' ../../reference-lambda/src/spawner.ts
   cd ../../reference-lambda
   npm install @kubernetes/client-node@^0.20.0
   ```
   `k8s-spawner.ts` is a true drop-in — it owns the `Spawner` interface and the `getSpawner()` factory, so no hand-editing of `spawner.ts` is needed after the copy.
3. Build and push the launcher container. The reference launcher ships a `Dockerfile` and an HTTP-server entry point (`src/server.ts`) so the same handler that runs on Lambda also runs as a long-lived pod:
   ```bash
   docker build -t your-registry/asserts-launcher:latest .
   docker push your-registry/asserts-launcher:latest
   ```
4. Fill in the `REPLACE_ME_*` values in [`manifests/launcher-deployment.yaml`](manifests/launcher-deployment.yaml) — launcher image, tenant slug, group name, Bearer token — and apply it:
   ```bash
   kubectl apply -f manifests/launcher-deployment.yaml
   ```
5. Read the Service's external URL and hand it to your Assert operator:
   ```bash
   kubectl -n asserts-launcher get service asserts-launcher
   ```
   The launcher serves plain HTTP on port 8080; the job-scaler calls it over HTTPS. Terminate TLS at the load balancer — `launcher-deployment.yaml` carries commented ACM-certificate annotations for EKS.

### Option B — launcher runs outside the cluster (Lambda, Cloud Run, VM)

If you want the launcher in serverless and the workers in a cluster:

1. Mint a kubeconfig file for a least-privilege ServiceAccount.
2. Store its contents in your secret manager (AWS Secrets Manager, Google Secret Manager).
3. Mount or fetch it at launcher cold start; pass to the k8s client library.
4. Use the same `K8sSpawner` code; just point the k8s client at the external API server.

---

## Files

| Path | Purpose |
|---|---|
| `k8s-spawner.ts` | Drop-in replacement for `reference-lambda/src/spawner.ts`. |
| `manifests/namespace.yaml` | A dedicated namespace for the launcher + workers. |
| `manifests/launcher-serviceaccount.yaml` | ServiceAccount the launcher pod runs as. |
| `manifests/launcher-rbac.yaml` | Role + RoleBinding granting scale-Deployment + delete-Pod permissions. |
| `manifests/launcher-deployment.yaml` | The launcher Deployment + Service + Bearer-token Secret. |
| `manifests/job-node-deployment.yaml` | The worker Deployment template + Secret reference. |

---

## RBAC scope

The launcher's ServiceAccount needs exactly three verbs:

| API group | Resource | Verbs |
|---|---|---|
| `apps` | `deployments` | `get`, `watch` (to observe the worker Deployment) |
| `apps` | `deployments/scale` | `get`, `update`, `patch` (read + bump `replicas` via the scale subresource) |
| `""` (core) | `pods` | `get`, `list`, `delete` (to terminate specific workers) |

Anything broader is over-privileged. The manifest in `launcher-rbac.yaml` is minimal.
