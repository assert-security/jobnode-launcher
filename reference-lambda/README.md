# Reference Launcher — AWS Lambda + API Gateway

A working implementation of [the Launcher Protocol v1](../PROTOCOL.md). Deploys as an AWS Lambda fronted by an HTTP API Gateway, with a DynamoDB table for idempotency dedupe.

It ships with a **stub spawner** that pretends to launch workers — see [`src/spawner.ts`](src/spawner.ts). You replace the stub with code that actually schedules the Venari job-node container in your environment. Worked examples for Kubernetes and ECS are at [`../examples/`](../examples/).

The protocol is satisfied end-to-end before you touch any code, so you can verify your deployment + auth + idempotency wiring against [`../conformance/conformance-test.sh`](../conformance/conformance-test.sh) before integrating with your real scheduler.

---

## Architecture

```
┌─────────────────┐        ┌───────────────────────┐        ┌────────────────────┐
│ Assert Security │ HTTPS  │ AWS API Gateway       │  Lambda│ Reference Lambda   │
│ job-scaler      │───────▶│ (HTTP API, $default)  │───────▶│ (this code)        │
└─────────────────┘        └───────────────────────┘        └────────┬───────────┘
                                                                     │
                                                  ┌──────────────────┼──────────────┐
                                                  │                  │              │
                                                  ▼                  ▼              ▼
                                          ┌──────────────┐  ┌─────────────┐  ┌──────────────┐
                                          │ Secrets Mgr  │  │ DynamoDB    │  │ Spawner      │
                                          │ (bearer tok) │  │ (dedupe)    │  │ (your code)  │
                                          └──────────────┘  └─────────────┘  └──────────────┘
```

---

## Prerequisites

- Node.js 20+
- AWS CLI v2 configured for the account you want to deploy into
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) 1.100+
- One secret in AWS Secrets Manager containing the bearer token your Assert Security operator issued you. SecretString = the raw token; nothing else.

---

## Configure

The launcher needs four pieces of configuration. Three come as Lambda env vars (set by the SAM template); the bearer token is fetched at cold start from Secrets Manager.

| Source | What |
|---|---|
| SAM parameter `TenantSlug` | Your tenant slug (e.g. `acme-corp`). |
| SAM parameter `GroupName` | The worker-group name (e.g. `ACME Internal`). Case-sensitive. |
| SAM parameter `BearerTokenSecretArn` | ARN of the Secrets Manager secret holding the bearer token. |
| SAM parameters `SpawnerMaxWorkers` / `SpawnerMinWorkers` | Ceiling and floor reported by `GET /workers`. The stub spawner enforces `maxWorkers` locally. Your real spawner should enforce them against your actual scheduler. |

You do NOT need to configure the worker's OAuth2 credentials (`node__*`) on the launcher itself — those are configured on the worker container template in your spawner adapter. See the [k8s example](../examples/k8s-spawner/manifests/job-node-deployment.yaml).

---

## Build

```bash
npm install
npm run build
```

`dist/` is what `sam build` packages.

---

## Deploy

```bash
sam build
sam deploy --guided
```

The guided deploy prompts for the four parameters above and confirms the IAM changes (DynamoDB CRUD + Secrets Manager read on your token secret). The stack outputs `LauncherBaseUrl` — hand this URL to your Assert Security operator.

For repeatable deploys, drop a `samconfig.toml` next to the template:

```toml
version = 0.1

[default.deploy.parameters]
stack_name = "asserts-launcher-acme"
region = "us-east-2"
parameter_overrides = "TenantSlug=acme-corp GroupName=\"ACME Internal\" BearerTokenSecretArn=arn:aws:secretsmanager:us-east-2:111111111111:secret:asserts-launcher-token-abc123 SpawnerMaxWorkers=8"
capabilities = "CAPABILITY_IAM"
resolve_s3 = true
```

---

## Run locally with SAM

For dev loops without deploying:

```bash
# Build
npm run build

# Set the env vars the handler reads. LAUNCHER_BEARER_TOKEN is a plain-text
# escape hatch used only when LAUNCHER_BEARER_TOKEN_SECRET_ARN is unset.
export LAUNCHER_BEARER_TOKEN="dev-token"
export LAUNCHER_TENANT_SLUG="acme-corp"
export LAUNCHER_GROUP_NAME="ACME Internal"
export SPAWNER_MAX_WORKERS="4"

# Start a local HTTP API on port 4000
sam local start-api --port 4000 \
    --parameter-overrides "TenantSlug=acme-corp GroupName=\"ACME Internal\" BearerTokenSecretArn=arn:aws:dummy SpawnerMaxWorkers=4 SpawnerMinWorkers=0"
```

Then exercise it:

```bash
curl -s -H "Authorization: Bearer dev-token" http://localhost:4000/health | jq
```

Or run the full conformance suite against the local instance:

```bash
export LAUNCHER_BASE_URL="http://localhost:4000"
export LAUNCHER_TOKEN="dev-token"
export LAUNCHER_TENANT_SLUG="acme-corp"
export LAUNCHER_GROUP_NAME="ACME Internal"
bash ../conformance/conformance-test.sh
```

> The stub spawner is in-memory. `sam local` recreates the Lambda execution environment for each batch of invocations, which means worker state resets unpredictably. For conformance runs against `sam local`, expect 1.x and 2.x to pass cleanly but multi-step assertions (idempotency replay across calls) may flake. Deploy to AWS for a complete run.

---

## Replace the stub spawner

Open [`src/spawner.ts`](src/spawner.ts) and look for the `// REPLACE-ME` block. Implement the `Spawner` interface against your scheduler:

```typescript
export interface Spawner {
  readonly maxWorkers: number;
  readonly minWorkers: number;
  list(): Promise<WorkerRecord[]>;
  launch(deltaCount: number): Promise<WorkerRecord[]>;
  terminate(workerId: string): Promise<void>;
  healthDetails(): Promise<Record<string, unknown>>;
}
```

Then change the `getSpawner()` factory to return your implementation instead of the stub. The handler does not need any other changes — protocol-level concerns (auth, idempotency, validation, response shape) are isolated.

`launch(deltaCount)` is the only one that needs an implementation note: the handler computes `deltaCount` as `desiredCount - currentCount`, so a delta of zero means "no new workers needed" and `launch(0)` is never called. You only need to handle positive deltas.

See [`../examples/k8s-spawner/`](../examples/k8s-spawner/) for a worked Kubernetes implementation.

---

## Logging

Lambda automatically captures `console.log` output to CloudWatch Logs. The reference handler doesn't add structured logging — pick the format your operational stack prefers (`pino`, `winston`, plain JSON, whatever). When you add it, log:

- `requestId` on every `POST /workers/launch` invocation
- Inbound path + method + response status
- Duration of any AWS SDK call

Never log the bearer token, the worker OAuth secret, or any prefix of either longer than 4 characters.

---

## Tests

```bash
npm test
```

The included tests are a happy-path smoke against the in-memory components. They do NOT replace the conformance suite — that exercises actual wire behaviour against a deployed launcher.
