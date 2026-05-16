# Job-Node Launcher Protocol — v1

Canonical wire contract between the Assert Security job-scaler and a customer-implemented launcher endpoint that brings up and tears down Venari job-node workers inside the customer's network.

**Status:** v1 (initial)
**Protocol version header:** `X-Protocol-Version: 1`
**Last revised:** 2026-05-14

---

## 1. Overview

In the Assert Security SAAS deployment, a customer can host their own Venari job-node workers — for example, to scan targets reachable only from inside the customer's network. The Assert Security-side **job-scaler** decides when those workers should run; the customer-implemented **launcher** is the thing that actually starts and stops them.

A launcher is any HTTPS endpoint that fulfills the four operations defined in §5. The protocol is intentionally **cloud-neutral** — it is HTTPS + JSON + Bearer auth, nothing more. Reasonable hosts include:

- **AWS** — Lambda + API Gateway (the reference implementation), ECS service, App Runner
- **Google Cloud** — Cloud Run, Cloud Functions gen2 (both work cleanly; an adapter ships in `examples/cloud-run-spawner/`)
- **Azure** — Azure Functions behind API Management, or Container Apps
- **Kubernetes** anywhere (GKE, EKS, AKS, on-prem, OpenShift) — a Service + Deployment in any language
- **Bare metal / VM** — Node, Go, Python, anything behind nginx, Caddy, or a load balancer terminating TLS

The protocol is intentionally lightweight so that "the thing that knows how to spawn workers in your environment" can be written as a few hundred lines of code on whatever runtime you already operate.

The launcher does not itself run Venari. It schedules the Venari job-node container that already lives in your environment — see the `examples/` directory for adapters that wrap a Kubernetes Deployment scale call and an ECS RunTask call.

### 1.1. Roles

| Role | Operated by | Responsibility |
|---|---|---|
| **Caller** | Assert Security job-scaler | Decides desired worker count per group; issues launch / terminate calls. |
| **Launcher** | Customer | Receives calls; spawns and terminates worker container instances. |
| **Worker** | Customer infra | The Venari job-node container; authenticates to the Assert Security master with OAuth2 client credentials supplied at launcher deploy time. |

### 1.2. Non-goals

- The protocol does not deliver worker credentials. The launcher is configured with the worker's OAuth2 `client_id`, `client_secret`, master URL, and scope **at deploy time** — out of band. See §8.
- The protocol does not describe *how* the launcher schedules workers. That is the customer's choice (k8s, ECS, Nomad, bare metal, whatever).
- The protocol does not negotiate transport, only the application-layer shape. TLS is mandatory (§3), and the launcher chooses its own ingress (API Gateway, ALB, Ingress controller, etc.).

---

## 2. Versioning

The protocol uses a single integer major version, emitted on every response as `X-Protocol-Version`.

| Change kind | Action |
|---|---|
| Adding an optional request or response field | No version bump. Callers and launchers ignore fields they do not recognise. |
| Adding a new endpoint | No version bump. New endpoints are discovered via the `capabilities` array on `GET /health` (§5.1). |
| Renaming, removing, or repurposing an existing field | Major version bump. |
| Changing required-field semantics (e.g. tightening idempotency window) | Major version bump. |

A launcher implementing v1 MUST emit `X-Protocol-Version: 1`. A launcher that has implemented v2 MAY emit `X-Protocol-Version: 2` and additionally advertise back-compat by treating v1 requests as a subset (§2.1).

### 2.1. Compatibility window

The Assert Security side commits to supporting at least the previous major version for 12 months after a new major ships. During that window the job-scaler MAY downgrade its requests to match the launcher's advertised version. After the window the launcher MUST upgrade or the group is treated as `degraded` (§9.3).

---

## 3. Transport

- **TLS 1.2 or higher.** Plaintext HTTP is rejected by the job-scaler. Self-signed certificates are acceptable in dev only and must be explicitly opted into per-tenant.
- **HTTP/1.1 or HTTP/2.** Both are supported; the job-scaler does not require HTTP/2.
- **JSON request and response bodies.** `Content-Type: application/json; charset=utf-8` on every request and response with a body.

---

## 4. Authentication

All requests carry a pre-shared bearer token in the `Authorization` header:

```
Authorization: Bearer <pre-shared-token>
```

The token is issued at tenant-provisioning time (see the operator playbook in the Assert Security private repo) and stored:

- Caller side: in AWS SSM Parameter Store as a `SecureString`, fetched at job-scaler startup, cached in memory, never written to logs.
- Launcher side: in the customer's secret store (AWS Secrets Manager, Kubernetes Secret, etc.), surfaced to the launcher process as an environment variable or fetched on cold start.

Token rotation is supported by issuing a new token, configuring both sides, and revoking the old one. There is no in-band rotation flow in v1.

### 4.1. Token verification

The launcher MUST:

1. Extract the bearer token from the `Authorization` header.
2. Compare it against its configured token using a constant-time comparator.
3. Reject any other authentication scheme (Basic, mTLS-only without bearer, etc.) with `401 Unauthorized`.
4. Never log the token value, the comparator output, or any prefix of the token longer than 4 characters.

### 4.2. Authentication failures

| Condition | Status | Body |
|---|---|---|
| No `Authorization` header | `401` | `{"error":"missing_authorization"}` |
| Header present but does not start with `Bearer ` | `401` | `{"error":"invalid_authorization_scheme"}` |
| Token does not match | `401` | `{"error":"invalid_token"}` |

The body is best-effort diagnostic; callers MUST NOT depend on specific `error` values for control flow. A `401` from any cause is treated as a credentials problem and surfaces a structured log event (§9.2).

---

## 5. Endpoints

All endpoints are relative to a base URL chosen by the customer and configured into the job-scaler at provisioning time. Example base URL: `https://launcher.acme.example.com/v1` — the customer may use any path; the job-scaler concatenates the endpoint paths defined below.

### 5.1. `GET /health`

Liveness check, protocol-version negotiation, and capability advertisement.

**Request:** no body.

**Response 200:**

```json
{
  "status": "healthy",
  "protocolVersion": 1,
  "capabilities": ["launch", "terminate", "list"],
  "details": {
    "implementation": "jobnode-launcher/reference-lambda@1.0.0",
    "spawnerBackend": "kubernetes",
    "currentWorkers": 3,
    "maxWorkers": 8
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `status` | enum: `healthy`, `degraded`, `unhealthy` | yes | Self-reported state. `degraded` means the launcher is reachable but its spawner backend is impaired (e.g. k8s API throttling). `unhealthy` means it cannot perform launches. |
| `protocolVersion` | integer | yes | Highest protocol major version the launcher implements. |
| `capabilities` | array of string | yes | Subset of `["launch","terminate","list"]`. A v1 launcher MUST advertise at least `["launch","list"]`. `terminate` is strongly recommended; if absent, the job-scaler will not call `DELETE /workers/{workerId}` and termination is the launcher's own concern. |
| `details` | object | no | Free-form diagnostic. The job-scaler logs the `implementation` and `spawnerBackend` fields verbatim on each iteration. |
| `details.currentWorkers` | integer | no | Hint of running worker count. Authoritative count comes from `GET /workers`. |
| `details.maxWorkers` | integer | no | Hint of the launcher's worker ceiling. |

The job-scaler calls `/health` at the start of every poll iteration. Three consecutive non-`healthy` results mark the group `degraded` server-side and pause launches for that group until a `healthy` response returns. `/workers` is still called during the degraded window so existing workers can drain naturally.

`/health` MUST respond within 2 seconds. Slower responses count as failures.

### 5.2. `GET /workers`

Current worker inventory.

**Request:** no body.

**Response 200:**

```json
{
  "workers": [
    {
      "workerId": "wkr-2c0b7f48",
      "state": "running",
      "startedAt": "2026-05-14T18:22:13Z"
    },
    {
      "workerId": "wkr-3e91a2c1",
      "state": "starting",
      "startedAt": "2026-05-14T18:24:01Z"
    }
  ],
  "limits": {
    "maxWorkers": 8,
    "minWorkers": 0
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `workers` | array | yes | One entry per worker tracked by the launcher. May be empty. |
| `workers[].workerId` | string | yes | Launcher-chosen identifier; opaque to the caller; stable for the lifetime of the worker. Must match `^[A-Za-z0-9_-]{1,64}$`. |
| `workers[].state` | enum: `starting`, `running`, `terminating`, `failed` | yes | Lifecycle state. The caller treats `starting` and `running` as "counted toward demand"; `terminating` and `failed` are not counted. |
| `workers[].startedAt` | RFC 3339 timestamp | yes | When the launcher first issued the spawn for this worker. |
| `limits.maxWorkers` | integer | yes | Hard ceiling; the launcher MUST NOT spawn beyond this on receipt of a `POST /workers/launch`. |
| `limits.minWorkers` | integer | yes | Soft floor; advisory. The caller will not call `DELETE` to drop below this when scaling down. |

The launcher SHOULD reconcile its returned `workers` array against actual underlying infrastructure each call — stale entries surface as `failed` or are removed. A worker that has been deleted by the underlying scheduler (e.g. a k8s pod evicted by the node) MUST disappear from `workers` within 30 seconds.

### 5.3. `POST /workers/launch`

Request that `desiredCount` workers be running. The launcher decides the delta against its current inventory and issues the necessary spawns. **Idempotent on `requestId`** — see §6.

**Request body:**

```json
{
  "requestId": "f1d4c2c8-9d22-4f8e-9e9f-86d3b5b9a17a",
  "desiredCount": 3,
  "tenantSlug": "acme-corp",
  "groupName": "ACME Internal",
  "context": {
    "queuedJobCount": 7,
    "originatingPoll": "2026-05-14T18:25:00Z"
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `requestId` | UUID v4 string | yes | Caller-supplied. Used by the launcher for idempotency. Must match `^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`. |
| `desiredCount` | integer ≥ 0 | yes | Target running-or-starting worker count after this call. NOT a delta. If `desiredCount` ≤ current, the launcher MUST NOT spawn anything; it MAY also do nothing toward terminating excess workers (the caller drives termination via `DELETE`). |
| `tenantSlug` | string | yes | Assert Security-side tenant identifier. Logged for audit; the launcher MAY reject a request whose `tenantSlug` does not match its configuration with `403`. |
| `groupName` | string | yes | The Assert Security-side worker-group name this launcher serves. Same audit + reject semantics as `tenantSlug`. |
| `context` | object | no | Free-form caller diagnostic. The launcher SHOULD log it but MUST NOT depend on any field. |

**Response 200 (or 202 if asynchronous):**

```json
{
  "accepted": true,
  "requestId": "f1d4c2c8-9d22-4f8e-9e9f-86d3b5b9a17a",
  "workerInstances": [
    {"workerId": "wkr-7d11a2c4", "state": "starting"},
    {"workerId": "wkr-7d11a2c5", "state": "starting"}
  ]
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `accepted` | boolean | yes | `true` if the launcher acted (spawned new workers, or determined no spawn was needed). `false` only when `reason` explains why. |
| `requestId` | UUID v4 string | yes | Echo of the caller-supplied `requestId`. |
| `workerInstances` | array | no | The launcher SHOULD list any newly-spawned workers here. May be omitted if no spawn was needed. |
| `reason` | string | conditional | Required when `accepted=false`. Free-text diagnostic. Logged by the caller. |

**Response 4xx and 5xx:** see §7. Notably:

- `400` for malformed request body (e.g. `desiredCount` negative, `requestId` not a UUID).
- `403` for `tenantSlug` / `groupName` mismatch.
- `409` if the launcher cannot spawn and the request is unrecoverable (rare; usually `accepted=false` is preferred so the caller learns the reason).
- `429` for transient back-pressure (caller retries with backoff per §7.3).
- `503` for transient backend failure (caller retries with backoff per §7.3).

`POST /workers/launch` MUST respond within 10 seconds. A response that takes longer counts as a `503` for the purposes of caller retry logic; the launcher SHOULD complete the spawn asynchronously and surface progress through `GET /workers` even when the synchronous response is a placeholder.

### 5.4. `DELETE /workers/{workerId}`

Terminate the named worker. Idempotent by HTTP semantics — deleting an already-deleted worker is success.

**Request:** no body.

**Response 204:** empty body. Indicates either (a) the worker has been signalled to terminate, or (b) the worker did not exist (or was already terminating). The caller does not distinguish these — both are success.

**Response 4xx and 5xx:** see §7. Notably:

- `400` for a `workerId` that does not match `^[A-Za-z0-9_-]{1,64}$`.
- `503` for transient backend failure.

`DELETE /workers/{workerId}` MUST respond within 5 seconds.

### 5.5. Reserved paths

The following paths are reserved for future protocol versions and MUST NOT be repurposed by launchers:

- `GET /workers/{workerId}` — single-worker detail
- `POST /workers/{workerId}/drain` — graceful drain signal
- `GET /metrics` — Prometheus-style metrics
- `GET /version` — separate version probe (currently folded into `/health`)

The following paths are reserved for container-runtime health probes and are not protocol endpoints. They are intentionally unauthenticated — a kubelet liveness/readiness probe cannot present a Bearer token. Launchers running as containers SHOULD respond to them with `200 ok`; launchers running on Lambda or other FaaS SHOULD ignore them (they will never arrive via API Gateway):

- `GET /livez` — liveness probe (used by the reference server.ts)
- `GET /readyz` — readiness probe (used by the reference server.ts)

---

## 6. Idempotency

`POST /workers/launch` is the only mutating endpoint that requires per-call idempotency. The launcher MUST:

1. On receipt of a `POST /workers/launch`, look up `requestId` in a dedupe cache.
2. If a prior response is cached, return that response verbatim (same status, same body). Do not act on the spawn again.
3. If not cached, perform the spawn logic, cache the response, and return it.
4. Retain dedupe entries for **at least 10 minutes** from the time of the original request. Longer is fine.

Recommended implementations:

- In-process LRU keyed on `requestId` — fine for single-instance launchers.
- DynamoDB with TTL — used by the reference Lambda; survives cold starts.
- Redis with `SETNX` + `EXPIRE` — fine if you already run Redis.

The caller generates a fresh `requestId` per logical launch decision. On transport-level retry (timeout, 5xx) the caller reuses the same `requestId` for up to 3 attempts spaced by exponential backoff (§7.3). After that the decision is abandoned and a new poll cycle generates a new `requestId`.

`DELETE` is idempotent by HTTP semantics — no dedupe cache needed.

`GET /health` and `GET /workers` are trivially idempotent.

---

## 7. Errors and retries

### 7.1. Status code summary

| Status | Meaning | Caller behaviour |
|---|---|---|
| `200` / `202` / `204` | success | continue |
| `400` | client error — request malformed | log, do not retry, mark group degraded |
| `401` | authentication failure | log, do not retry, mark group degraded, alert operator |
| `403` | authorization failure (tenant/group mismatch) | log, do not retry, mark group degraded, alert operator |
| `404` | not applicable to v1 (no nested resources) | log, do not retry |
| `409` | conflict — request rejected for permanent reason | log, do not retry |
| `429` | rate-limited / back-pressure | retry with backoff (§7.3) |
| `500`-`503` | transient backend error | retry with backoff (§7.3) |
| `504` (gateway timeout) | treated like `503` | retry with backoff |

### 7.2. Error response body

For any non-2xx response, the launcher SHOULD return:

```json
{
  "error": "short_machine_readable_code",
  "message": "Human-readable explanation."
}
```

Neither field is mandatory; the caller only depends on the HTTP status code. The body is for diagnostic logging.

### 7.3. Retry policy

The caller retries on `429`, `500`-`504`, network timeout, and connection reset. Retry budget:

- Maximum 3 attempts total per request (including the initial call)
- Exponential backoff: 1s, 4s, 16s (with ±20% jitter)
- All retries reuse the same `requestId` for `POST /workers/launch`

After 3 failed attempts the caller logs a structured error event, marks the group as degraded, and skips that group for the rest of the poll cycle. The next poll iteration generates a fresh `requestId` and tries again.

The caller does NOT retry on `4xx` other than `429`. `4xx`s indicate a configuration or compatibility problem and retrying won't help.

---

## 8. Worker credentials

The Venari job-node container that the launcher spawns needs four environment variables to connect to the Assert Security master:

| Variable | Secret? | Source |
|---|---|---|
| `node__masternodebaseaddress` | no | Issued at provisioning, configured at launcher deploy time |
| `node__authinfo__clientid` | no | Issued at provisioning, configured at launcher deploy time |
| `node__authinfo__clientsecret` | **yes** | Issued at provisioning, stored in your secret manager |
| `node__authinfo__scope` | no | Issued at provisioning, configured at launcher deploy time |

These values are NOT sent in the `POST /workers/launch` body. The launcher pre-knows them from its own configuration and injects them into the worker container when it spawns.

Rationale: keeps credentials out of the request path so they're not at risk in launcher logs, retry payloads, or transient breach windows. Customers can rotate their own secret-storage backend (AWS Secrets Manager, Vault, k8s Secret) without renegotiating the protocol.

See the reference Lambda's `template.yaml` and the k8s spawner's `manifests/job-node-deployment.yaml` for concrete injection patterns.

---

## 9. Operational expectations

### 9.1. Logging

The launcher SHOULD emit a structured log line for every inbound request, including:

- `requestId` (for `POST /workers/launch`)
- inbound path + verb
- response status
- duration
- a stable correlation ID (the launcher's own choice — useful for cross-correlating launcher logs with worker pod logs)

The launcher MUST NOT log:

- The bearer token (or any prefix longer than 4 characters)
- The worker `node__authinfo__clientsecret`
- The contents of `Authorization` headers verbatim

### 9.2. Caller-side observability

The job-scaler emits one log line per group per iteration, including:

- `group_demand` — readyJobs, runningWorkers, action, delta
- `launcher_health` — group, status, response duration
- `webhook_call` — verb, path, requestId, responseStatus, durationMs
- `webhook_failure` — verb, path, requestId, attempt, errorClass

The bearer token is never logged caller-side. `requestId` is logged on every retry attempt for the same logical launch.

### 9.3. Degraded mode

A group is `degraded` when any of the following hold:

- Three consecutive `/health` failures (any non-`healthy` `status`, non-200, timeout, or network error)
- A `401` or `403` response to any endpoint (auth/config problem)
- A `4xx` other than `429` on `POST /workers/launch`

While degraded:

- The caller continues to call `/workers` to drain existing workers naturally
- The caller does NOT call `POST /workers/launch` for that group
- The caller still honours `DELETE /workers/{workerId}` for scale-down

A group exits degraded mode on the first successful `/health` with `status: "healthy"`.

### 9.4. Worker lifetime

The launcher is responsible for the worker process's lifetime: spawn on launch, terminate on `DELETE`, optionally terminate on its own backend's signals (e.g. k8s pod eviction). The worker is otherwise expected to run until terminated.

A worker that has registered with the Assert Security master and is in `running` state SHOULD continue until either the caller issues `DELETE` or the underlying infra removes it. Worker self-termination on idle is not part of v1 — the caller has authoritative knowledge of demand.

---

## 10. Examples

### 10.1. Healthy launcher, no demand

```
GET /health HTTP/1.1
Host: launcher.acme.example.com
Authorization: Bearer ...

HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
X-Protocol-Version: 1

{"status":"healthy","protocolVersion":1,"capabilities":["launch","terminate","list"]}
```

```
GET /workers HTTP/1.1
Host: launcher.acme.example.com
Authorization: Bearer ...

HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
X-Protocol-Version: 1

{"workers":[],"limits":{"maxWorkers":8,"minWorkers":0}}
```

### 10.2. Launch two workers

```
POST /workers/launch HTTP/1.1
Host: launcher.acme.example.com
Authorization: Bearer ...
Content-Type: application/json; charset=utf-8

{"requestId":"f1d4c2c8-9d22-4f8e-9e9f-86d3b5b9a17a","desiredCount":2,"tenantSlug":"acme-corp","groupName":"ACME Internal"}

HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
X-Protocol-Version: 1

{"accepted":true,"requestId":"f1d4c2c8-9d22-4f8e-9e9f-86d3b5b9a17a","workerInstances":[{"workerId":"wkr-7d11a2c4","state":"starting"},{"workerId":"wkr-7d11a2c5","state":"starting"}]}
```

### 10.3. Retry after transient failure

First attempt times out. The caller retries with the same `requestId`:

```
POST /workers/launch HTTP/1.1
... (same body, same requestId)

HTTP/1.1 200 OK
... (launcher returns the cached response from the first attempt, even though it never reached the caller)
```

### 10.4. Terminate a worker

```
DELETE /workers/wkr-7d11a2c4 HTTP/1.1
Host: launcher.acme.example.com
Authorization: Bearer ...

HTTP/1.1 204 No Content
X-Protocol-Version: 1
```

### 10.5. Authentication failure

```
GET /workers HTTP/1.1
Host: launcher.acme.example.com
Authorization: Bearer wrong-token

HTTP/1.1 401 Unauthorized
Content-Type: application/json; charset=utf-8
X-Protocol-Version: 1

{"error":"invalid_token","message":"Bearer token does not match the configured value."}
```

---

## 11. Conformance

A launcher implementation is conformant to v1 if it passes every assertion in [CONFORMANCE.md](CONFORMANCE.md). The conformance script is the executable form of this specification — when the script and the prose disagree, the script takes precedence and a clarification PR against this document is welcomed.

---

## Appendix A — Reserved fields

The following request and response fields are RESERVED for future protocol versions. Implementations MUST NOT use these names for their own purposes:

- `priority` (POST /workers/launch request)
- `region` (POST /workers/launch request)
- `metadata` (any endpoint, request or response)
- `signature` (any endpoint — reserved for v2 HMAC-signed requests)
- `expiresAt` (response, reserved for credential-rotation hints)

A launcher that encounters an unknown field MUST ignore it (forwards-compat).
