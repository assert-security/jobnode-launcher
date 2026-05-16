# Conformance Checklist — Launcher Protocol v1

This document is the executable form of [PROTOCOL.md](PROTOCOL.md). A launcher implementation is considered conformant when it passes every assertion below. The scripts in [conformance/](conformance/) automate the runtime assertions — read this file when an assertion fails to understand what behaviour is being checked and why.

When the script and the prose disagree, **the script is canonical**. File a PR against this document to fix the drift.

---

## How to run the conformance suite

1. Deploy your launcher to a reachable test environment.
2. Set environment variables:
   - `LAUNCHER_BASE_URL` — e.g. `https://launcher.acme.example.com/v1`
   - `LAUNCHER_TOKEN` — the bearer token your launcher accepts
   - `LAUNCHER_TENANT_SLUG` — the tenant slug it is configured for (e.g. `acme-corp`)
   - `LAUNCHER_GROUP_NAME` — the group name it is configured for (e.g. `ACME Internal`)
3. Run one of:
   - `bash conformance/conformance-test.sh` (Linux / macOS / WSL)
   - `pwsh conformance/conformance-test.ps1` (Windows / PowerShell)

The script exits 0 on success, non-zero on first failure, and prints which section failed.

> The conformance suite spawns and terminates real workers if your launcher passes earlier assertions. Run it against a sandbox; do not point it at a production endpoint with a saturated cluster.

---

## Assertions

Each numbered item below is one assertion. Numbers correspond to test IDs in the conformance scripts.

### 1. Transport

1.1. The base URL uses HTTPS.
1.2. **Manual (see M6 below).** The launcher accepts TLS 1.2 connections; TLS 1.3 if the platform supports it. Verifying the minimum TLS version from within a curl-based script requires environment-specific certificate and listener configuration that varies too widely to automate reliably. Verify out-of-band using your TLS scanning tool of choice (e.g. `openssl s_client -tls1_1 host:443` should fail; `openssl s_client -tls1_2 host:443` should succeed).
1.3. Every response sets `Content-Type: application/json; charset=utf-8` when a body is present.
1.4. Every response sets `X-Protocol-Version: 1`.

### 2. Authentication

2.1. A request with no `Authorization` header returns `401`.
2.2. A request with `Authorization: Basic ...` returns `401`.
2.3. A request with `Authorization: Bearer wrong-token` returns `401`.
2.4. A request with the correct bearer token is accepted (`/health` returns 200).
2.5. The error body for any `401` is well-formed JSON (parseable, ≤ 1KB).
2.6. **Manual:** No bearer-token-derived value (full token, or prefix longer than 4 characters) appears in any log line. Verify by inspecting the launcher's recent logs after running the suite.

### 3. `GET /health`

3.1. Returns 200 with a JSON body.
3.2. Body includes `status` (one of `healthy`, `degraded`, `unhealthy`).
3.3. Body includes `protocolVersion: 1`.
3.4. Body includes `capabilities` as an array of strings.
3.5. `capabilities` contains at least `launch` and `list`.
3.6. Response arrives within 2 seconds.

### 4. `GET /workers`

4.1. Returns 200 with a JSON body.
4.2. Body includes `workers` as an array (possibly empty).
4.3. Body includes `limits.maxWorkers` (integer) and `limits.minWorkers` (integer).
4.4. Every `workers[i]` has `workerId` (string matching `^[A-Za-z0-9_-]{1,64}$`), `state` (enum), and `startedAt` (RFC 3339 string).

### 5. `POST /workers/launch`

5.1. A well-formed request with `desiredCount: 1` returns 200 or 202 with `accepted: true`.
5.2. The response echoes the `requestId` from the request.
5.3. After a successful launch, `GET /workers` shows at least one entry within 30 seconds.

### 6. Idempotency

6.1. Calling `POST /workers/launch` twice with the **same** `requestId` and `desiredCount: 1` returns the same response body both times.
6.2. After two calls with the same `requestId`, only one new worker appears in `GET /workers` (not two).
6.3. Calling `POST /workers/launch` with a **different** `requestId` and `desiredCount: 2` causes a second worker to spawn (verify via `GET /workers`).
6.4. The dedupe window survives for at least 10 minutes. The script verifies this by sleeping the gap and re-issuing the same `requestId`.

### 7. Validation

7.1. `POST /workers/launch` with `requestId: "not-a-uuid"` returns 400.
7.2. `POST /workers/launch` with `desiredCount: -1` returns 400.
7.3. `POST /workers/launch` with missing `tenantSlug` returns 400.
7.4. `DELETE /workers/$%@!` returns 400.
7.5. `POST /workers/launch` with the wrong `tenantSlug` returns 403.
7.6. `POST /workers/launch` with the wrong `groupName` returns 403.

### 8. `DELETE /workers/{workerId}`

8.1. `DELETE` against a real worker (one that appears in `GET /workers`) returns 204.
8.2. After `DELETE`, the worker disappears from `GET /workers` within 30 seconds.
8.3. `DELETE` against a fabricated workerId (well-formed but never spawned) returns 204 (idempotent on absent resources).
8.4. `DELETE` against the same workerId twice returns 204 both times.

### 9. Capacity

9.1. Calling `POST /workers/launch` with `desiredCount` greater than `limits.maxWorkers` does NOT spawn more workers than the limit. The launcher may return `accepted: true` with fewer than `desiredCount` spawned, or `accepted: false` with a reason — either is conformant. The post-call `GET /workers` count MUST NOT exceed `maxWorkers`.

### 10. Cleanup

10.1. The script terminates every worker it spawned before exiting. If the suite leaves orphaned workers, fix the launcher's `DELETE` path — it is not conformant.

---

## Manual / out-of-band verifications

These cannot be expressed as HTTP assertions:

- **M1.** The bearer token is stored in a secret manager (AWS Secrets Manager, k8s Secret, etc.) — not committed to a repo or set in a plain env var that ends up in process listings on shared hosts.
- **M2.** The bearer token is fetched on launcher cold start and held only in process memory thereafter.
- **M3.** When the worker container starts, `node__authinfo__clientsecret` is injected from the launcher's own secret store — not embedded in an image, baked into a config map, or transmitted across the protocol.
- **M4.** The launcher's logs contain neither the bearer token nor `node__authinfo__clientsecret`. Grep them.
- **M5.** TLS certificates used by the launcher endpoint are issued by a public CA or by your private CA bundle that the Assert Security side trusts. Self-signed certificates are dev-only.
- **M6.** (Corresponds to assertion 1.2.) The launcher accepts TLS 1.2 connections. Verify by attempting a TLS 1.1 handshake (should fail) and a TLS 1.2 handshake (should succeed): `openssl s_client -connect <host>:443 -tls1_1` should return a handshake failure; `openssl s_client -connect <host>:443 -tls1_2` should complete successfully.

---

## Reporting conformance

If you're integrating, send the following to your Assert Security operator after a green run:

- The git SHA of your launcher source
- The output of the conformance script (the green summary, not the per-assertion noise)
- The base URL and a sample `GET /health` response so the operator can verify reachability
- Confirmation of M1–M5 above

The operator wires the URL and a freshly-rotated bearer token into your tenant's master configuration. From that point, scans dispatch to your launcher.
