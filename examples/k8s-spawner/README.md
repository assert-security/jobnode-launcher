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
- The Secret holding `VENARI_JOBNODE_CLIENT_SECRET` — you create that once and reference it from the Deployment

---

## Install

This adapter is a reference *for the spawner step only*. You still deploy the reference Launcher itself; only `src/spawner.ts` is swapped.

### Option A — launcher is itself a pod in the cluster

The most common shape: the launcher and the workers live in the same cluster, the launcher's pod has a ServiceAccount with permission to scale the worker Deployment and delete its pods.

1. Apply the manifests:
   ```bash
   kubectl apply -f manifests/namespace.yaml
   kubectl apply -f manifests/launcher-serviceaccount.yaml
   kubectl apply -f manifests/launcher-rbac.yaml
   kubectl apply -f manifests/job-node-deployment.yaml
   ```
2. Build the launcher container with the k8s spawner swapped in:
   ```bash
   cp k8s-spawner.ts ../../reference-lambda/src/spawner.ts
   # (then edit src/spawner.ts to export getSpawner returning new K8sSpawner({...}))
   docker build -t your-registry/asserts-launcher:latest ../../reference-lambda
   ```
3. Deploy the launcher as a Deployment + Service in the cluster. Hand the Service's external URL to your Assert operator.

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
| `manifests/job-node-deployment.yaml` | The worker Deployment template + Secret reference. |

---

## RBAC scope

The launcher's ServiceAccount needs exactly three verbs:

| API group | Resource | Verbs |
|---|---|---|
| `apps` | `deployments` | `get`, `update`, `patch` (to read + bump `replicas`) |
| `apps` | `deployments/scale` | `get`, `update`, `patch` (the scale subresource) |
| `""` (core) | `pods` | `get`, `list`, `delete` (to terminate specific workers) |

Anything broader is over-privileged. The manifest in `launcher-rbac.yaml` is minimal.
