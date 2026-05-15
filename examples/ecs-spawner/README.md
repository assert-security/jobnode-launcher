# AWS ECS Spawner Adapter

Implementation of the `Spawner` interface that runs Venari job-node workers as ECS Fargate tasks. An alternative to [`../k8s-spawner/`](../k8s-spawner/) for AWS-native shops that don't already run Kubernetes.

The launcher stays on AWS Lambda (the reference); only the spawn step changes.

---

## Architecture

```
┌─────────────────┐  HTTPS  ┌────────────────┐  ECS API  ┌────────────────┐
│ Assert job-     │────────▶│ Lambda         │──────────▶│ ECS cluster    │
│ scaler          │         │ (launcher)     │           │ (Fargate tasks)│
└─────────────────┘         └────────────────┘           └────────────────┘
                                                                  │
                                                                  ▼
                                                         ┌────────────────┐
                                                         │ ECR (jobnode   │
                                                         │  image)        │
                                                         └────────────────┘
```

Workers are launched as one-shot Fargate tasks (`RunTask`). The Task Definition references the job-node image and injects the `VENARI_*` env vars from Secrets Manager / SSM Parameter Store.

---

## Files

| Path | Purpose |
|---|---|
| `ecs-spawner.ts` | Drop-in replacement for `reference-lambda/src/spawner.ts`. |
| `task-definition.json` | ECS task definition template for the job-node container. Register once via `aws ecs register-task-definition`. |
| `iam-policy.json` | IAM permissions the Lambda execution role needs (ECS RunTask, DescribeTasks, StopTask). |

---

## Wire-up

1. Create an ECS cluster (Fargate) in the same VPC where workers can reach scan targets.
2. Register the task definition:
   ```bash
   aws ecs register-task-definition --cli-input-json file://task-definition.json
   ```
3. Store the four worker env-var values as SSM Parameters (SecureString for `node__authinfo__clientsecret`).
4. Attach `iam-policy.json` to the Lambda execution role created by the reference SAM template.
5. Build the launcher with the ECS spawner swapped in:
   ```bash
   cp ecs-spawner.ts ../../reference-lambda/src/spawner.ts
   # (edit src/spawner.ts to export getSpawner returning new EcsSpawner({...}))
   cd ../../reference-lambda && npm run build && sam build && sam deploy
   ```

---

## Why Fargate instead of EC2

- No host management — Fargate is the right shape for irregular, short-lived burst workloads
- Same task definition works in Linux/x86 and Linux/arm64 with the architecture flag
- No spot-fleet failure modes to handle in the launcher

If you already have an ECS cluster with EC2 capacity, the same `RunTask` flow works against it — change `launchType: "FARGATE"` to `"EC2"` and ensure the cluster has capacity. The spawner interface stays the same.
