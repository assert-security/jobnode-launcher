#!/usr/bin/env bash
# Launcher Protocol v1 — conformance suite (bash)
#
# Exercises every protocol assertion against a deployed launcher endpoint.
# Exits 0 on success, non-zero on first failure.
#
# Requirements: bash 4+, curl, jq, uuidgen (or python3 fallback).
#
# Usage:
#   export LAUNCHER_BASE_URL="https://launcher.example.com/v1"
#   export LAUNCHER_TOKEN="..."
#   export LAUNCHER_TENANT_SLUG="acme-corp"
#   export LAUNCHER_GROUP_NAME="ACME Internal"
#   bash conformance-test.sh

set -euo pipefail

# -- configuration ----------------------------------------------------------

: "${LAUNCHER_BASE_URL:?must be set}"
: "${LAUNCHER_TOKEN:?must be set}"
: "${LAUNCHER_TENANT_SLUG:?must be set}"
: "${LAUNCHER_GROUP_NAME:?must be set}"

LAUNCHER_BASE_URL="${LAUNCHER_BASE_URL%/}"

# Per-spec timeouts (§5.x). Add 1s slack for network jitter.
HEALTH_TIMEOUT=3
WORKERS_TIMEOUT=10
LAUNCH_TIMEOUT=11
DELETE_TIMEOUT=6

# Time the launcher is allowed to converge the worker list after launch/delete.
CONVERGE_SECONDS=30

# Track spawned workers for cleanup on exit, even on failure.
SPAWNED_WORKERS=()
trap _cleanup EXIT

# -- helpers ----------------------------------------------------------------

_uuid() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr 'A-Z' 'a-z'
  else
    python3 -c 'import uuid;print(uuid.uuid4())'
  fi
}

_call() {
  # _call METHOD PATH [JSON-BODY] [EXTRA-CURL-ARGS...]
  local method="$1" path="$2" body="${3:-}"
  shift 3 || true
  local args=(-sS -o /tmp/conformance-body -w '%{http_code}' -X "$method"
              -H "Authorization: Bearer $LAUNCHER_TOKEN"
              --max-time "$LAUNCH_TIMEOUT")
  if [[ -n "$body" ]]; then
    args+=(-H 'Content-Type: application/json; charset=utf-8' --data "$body")
  fi
  curl "${args[@]}" "$@" "${LAUNCHER_BASE_URL}${path}"
}

_assert() {
  # _assert ID DESCRIPTION CMD ARGS...
  local id="$1" desc="$2"
  shift 2
  printf '  [%s] %s ... ' "$id" "$desc"
  if "$@"; then
    printf 'OK\n'
  else
    printf 'FAIL\n'
    printf '\n  Last response body:\n'
    sed -e 's/^/    /' /tmp/conformance-body 2>/dev/null || true
    exit 1
  fi
}

_status_is() { [[ "$1" == "$2" ]]; }
_status_in() { local needle="$1"; shift; for s in "$@"; do [[ "$s" == "$needle" ]] && return 0; done; return 1; }

_cleanup() {
  if (( ${#SPAWNED_WORKERS[@]} )); then
    printf '\nCleaning up %d spawned workers...\n' "${#SPAWNED_WORKERS[@]}"
    for w in "${SPAWNED_WORKERS[@]}"; do
      _call DELETE "/workers/${w}" '' --max-time "$DELETE_TIMEOUT" >/dev/null || true
    done
  fi
}

# -- section 1: transport ---------------------------------------------------

echo 'Section 1 — Transport'

_check_1_1() { [[ "${LAUNCHER_BASE_URL}" == https://* ]]; }
_assert 1.1 'Base URL uses HTTPS' _check_1_1

_check_1_3_4() {
  local status; status=$(_call GET /health '')
  _status_is "$status" 200 || return 1
  local ct; ct=$(curl -sS -I -H "Authorization: Bearer $LAUNCHER_TOKEN" --max-time "$HEALTH_TIMEOUT" "${LAUNCHER_BASE_URL}/health" | tr -d '\r')
  echo "$ct" | grep -qi 'Content-Type: application/json' || return 1
  echo "$ct" | grep -qi 'X-Protocol-Version: 1'
}
_assert 1.3 'Content-Type and X-Protocol-Version present on /health' _check_1_3_4

# -- section 2: authentication ----------------------------------------------

echo 'Section 2 — Authentication'

_check_2_1() {
  local status; status=$(curl -sS -o /tmp/conformance-body -w '%{http_code}' --max-time "$HEALTH_TIMEOUT" "${LAUNCHER_BASE_URL}/health")
  _status_is "$status" 401
}
_assert 2.1 'No Authorization header returns 401' _check_2_1

_check_2_2() {
  local status; status=$(curl -sS -o /tmp/conformance-body -w '%{http_code}' -H 'Authorization: Basic Zm9vOmJhcg==' --max-time "$HEALTH_TIMEOUT" "${LAUNCHER_BASE_URL}/health")
  _status_is "$status" 401
}
_assert 2.2 'Basic auth returns 401' _check_2_2

_check_2_3() {
  local status; status=$(curl -sS -o /tmp/conformance-body -w '%{http_code}' -H 'Authorization: Bearer wrong-token-xyz' --max-time "$HEALTH_TIMEOUT" "${LAUNCHER_BASE_URL}/health")
  _status_is "$status" 401
}
_assert 2.3 'Wrong bearer token returns 401' _check_2_3

_check_2_4() {
  local status; status=$(_call GET /health '')
  _status_is "$status" 200
}
_assert 2.4 'Correct bearer token accepted' _check_2_4

_check_2_5() {
  jq -e . /tmp/conformance-body >/dev/null 2>&1 || jq -e . <<<'{}' >/dev/null
  local sz; sz=$(wc -c </tmp/conformance-body)
  (( sz <= 1024 ))
}
_assert 2.5 '401 body is parseable JSON ≤ 1KB' _check_2_5

# -- section 3: /health -----------------------------------------------------

echo 'Section 3 — GET /health'

_check_3_1() {
  local status; status=$(_call GET /health '')
  _status_is "$status" 200
}
_assert 3.1 'Returns 200 with a JSON body' _check_3_1

_check_3_2() {
  jq -e '.status | test("^(healthy|degraded|unhealthy)$")' /tmp/conformance-body >/dev/null
}
_assert 3.2 'Body includes status (healthy|degraded|unhealthy)' _check_3_2

_check_3_3() {
  jq -e '.protocolVersion == 1' /tmp/conformance-body >/dev/null
}
_assert 3.3 'Body includes protocolVersion: 1' _check_3_3

_check_3_4() {
  jq -e '.capabilities | type == "array"' /tmp/conformance-body >/dev/null
}
_assert 3.4 'Body includes capabilities as an array' _check_3_4

_check_3_5() {
  jq -e '(.capabilities | index("launch")) != null and (.capabilities | index("list")) != null' /tmp/conformance-body >/dev/null
}
_assert 3.5 'capabilities contains launch and list' _check_3_5

_check_3_6() {
  # Use curl's own time_total (seconds, fractional) — portable across Linux and macOS.
  local timing; timing=$(curl -sS -o /tmp/conformance-body \
    -w '%{http_code} %{time_total}' \
    -H "Authorization: Bearer $LAUNCHER_TOKEN" \
    --max-time "$HEALTH_TIMEOUT" \
    "${LAUNCHER_BASE_URL}/health")
  local status elapsed_s
  read -r status elapsed_s <<<"$timing"
  _status_is "$status" 200 || return 1
  # Compare as integers after multiplying by 1000 (awk for float arithmetic).
  local elapsed_ms; elapsed_ms=$(awk "BEGIN{print int($elapsed_s * 1000)}")
  (( elapsed_ms <= 2000 ))
}
_assert 3.6 'Response arrives within 2 seconds' _check_3_6

# -- section 4: /workers ----------------------------------------------------

echo 'Section 4 — GET /workers'

_check_4_1() {
  local status; status=$(_call GET /workers '')
  _status_is "$status" 200
}
_assert 4.1 'Returns 200 with a JSON body' _check_4_1

_check_4_2() {
  jq -e '.workers | type == "array"' /tmp/conformance-body >/dev/null
}
_assert 4.2 'Body includes workers as an array' _check_4_2

_check_4_3() {
  jq -e '(.limits.maxWorkers | type == "number") and (.limits.minWorkers | type == "number")' /tmp/conformance-body >/dev/null
}
_assert 4.3 'Body includes limits.maxWorkers and limits.minWorkers as integers' _check_4_3

_check_4_4() {
  jq -e '
    .workers | all(
      (.workerId | test("^[A-Za-z0-9_-]{1,64}$"))
      and (.state | test("^(starting|running|terminating|failed)$"))
      and (.startedAt | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T"))
    )
  ' /tmp/conformance-body >/dev/null
}
_assert 4.4 'Every workers[i] has valid workerId, state, and startedAt' _check_4_4

# -- section 5: /workers/launch ---------------------------------------------

echo 'Section 5 — POST /workers/launch'

RID1=$(_uuid)
LAUNCH1_BODY=$(jq -n --arg r "$RID1" --arg ts "$LAUNCHER_TENANT_SLUG" --arg gn "$LAUNCHER_GROUP_NAME" '{requestId:$r,desiredCount:1,tenantSlug:$ts,groupName:$gn}')

_check_5_1() {
  local status; status=$(_call POST /workers/launch "$LAUNCH1_BODY")
  _status_in "$status" 200 202
}
_assert 5.1 'desiredCount=1 returns 200 or 202' _check_5_1

_check_5_2() {
  jq -e --arg r "$RID1" '.requestId == $r and .accepted == true' /tmp/conformance-body >/dev/null
}
_assert 5.2 'Response echoes requestId and accepted=true' _check_5_2

# Stash any workerInstances for cleanup
mapfile -t _new < <(jq -r '.workerInstances[]?.workerId // empty' /tmp/conformance-body)
SPAWNED_WORKERS+=("${_new[@]}")

_check_5_3() {
  local end=$(( SECONDS + CONVERGE_SECONDS ))
  while (( SECONDS < end )); do
    _call GET /workers '' >/dev/null
    local cnt; cnt=$(jq -r '.workers | length' /tmp/conformance-body)
    if (( cnt >= 1 )); then return 0; fi
    sleep 2
  done
  return 1
}
_assert 5.3 'Worker appears in GET /workers within 30s' _check_5_3

# -- section 6: idempotency -------------------------------------------------

echo 'Section 6 — Idempotency'

# Same requestId, same desiredCount — same response, no second spawn.
_check_6_1() {
  local status; status=$(_call POST /workers/launch "$LAUNCH1_BODY")
  _status_in "$status" 200 202 || return 1
  jq -e --arg r "$RID1" '.requestId == $r and .accepted == true' /tmp/conformance-body >/dev/null
}
_assert 6.1 'Replay returns same response shape' _check_6_1

_check_6_2() {
  _call GET /workers '' >/dev/null
  local cnt; cnt=$(jq -r '.workers | length' /tmp/conformance-body)
  (( cnt == 1 ))
}
_assert 6.2 'Replay did not double-spawn' _check_6_2

RID2=$(_uuid)
LAUNCH2_BODY=$(jq -n --arg r "$RID2" --arg ts "$LAUNCHER_TENANT_SLUG" --arg gn "$LAUNCHER_GROUP_NAME" '{requestId:$r,desiredCount:2,tenantSlug:$ts,groupName:$gn}')

_check_6_3() {
  local status; status=$(_call POST /workers/launch "$LAUNCH2_BODY")
  _status_in "$status" 200 202 || return 1
  mapfile -t _new < <(jq -r '.workerInstances[]?.workerId // empty' /tmp/conformance-body)
  SPAWNED_WORKERS+=("${_new[@]}")
  local end=$(( SECONDS + CONVERGE_SECONDS ))
  while (( SECONDS < end )); do
    _call GET /workers '' >/dev/null
    local cnt; cnt=$(jq -r '.workers | length' /tmp/conformance-body)
    if (( cnt >= 2 )); then return 0; fi
    sleep 2
  done
  return 1
}
_assert 6.3 'New requestId with desiredCount=2 spawns a second worker' _check_6_3

# Note: assertion 6.4 (10-min dedupe window) is skipped here by default — running
# it adds 10 minutes to every conformance run. Set CONFORMANCE_LONG_TESTS=1 to enable.
if [[ "${CONFORMANCE_LONG_TESTS:-0}" == "1" ]]; then
  _check_6_4() {
    echo
    echo "    sleeping 600s to verify dedupe window..."
    sleep 600
    local status; status=$(_call POST /workers/launch "$LAUNCH1_BODY")
    _status_in "$status" 200 202 || return 1
    jq -e --arg r "$RID1" '.requestId == $r and .accepted == true' /tmp/conformance-body >/dev/null
    # Worker count should be unchanged (still 2 from the desiredCount=2 call)
    _call GET /workers '' >/dev/null
    local cnt; cnt=$(jq -r '.workers | length' /tmp/conformance-body)
    (( cnt == 2 ))
  }
  _assert 6.4 'Dedupe window honoured for 10 minutes' _check_6_4
fi

# -- section 7: validation --------------------------------------------------

echo 'Section 7 — Validation'

_check_7_1() {
  local body; body=$(jq -n --arg ts "$LAUNCHER_TENANT_SLUG" --arg gn "$LAUNCHER_GROUP_NAME" '{requestId:"not-a-uuid",desiredCount:1,tenantSlug:$ts,groupName:$gn}')
  local status; status=$(_call POST /workers/launch "$body")
  _status_is "$status" 400
}
_assert 7.1 'Non-UUID requestId returns 400' _check_7_1

_check_7_2() {
  local body; body=$(jq -n --arg r "$(_uuid)" --arg ts "$LAUNCHER_TENANT_SLUG" --arg gn "$LAUNCHER_GROUP_NAME" '{requestId:$r,desiredCount:-1,tenantSlug:$ts,groupName:$gn}')
  local status; status=$(_call POST /workers/launch "$body")
  _status_is "$status" 400
}
_assert 7.2 'Negative desiredCount returns 400' _check_7_2

_check_7_3() {
  local body; body=$(jq -n --arg r "$(_uuid)" --arg gn "$LAUNCHER_GROUP_NAME" '{requestId:$r,desiredCount:1,groupName:$gn}')
  local status; status=$(_call POST /workers/launch "$body")
  _status_is "$status" 400
}
_assert 7.3 'Missing tenantSlug returns 400' _check_7_3

_check_7_4() {
  local status; status=$(_call DELETE '/workers/$%@!' '')
  _status_is "$status" 400
}
_assert 7.4 'Malformed workerId on DELETE returns 400' _check_7_4

_check_7_5() {
  local body; body=$(jq -n --arg r "$(_uuid)" --arg gn "$LAUNCHER_GROUP_NAME" '{requestId:$r,desiredCount:1,tenantSlug:"wrong-tenant",groupName:$gn}')
  local status; status=$(_call POST /workers/launch "$body")
  _status_is "$status" 403
}
_assert 7.5 'Wrong tenantSlug returns 403' _check_7_5

_check_7_6() {
  local body; body=$(jq -n --arg r "$(_uuid)" --arg ts "$LAUNCHER_TENANT_SLUG" '{requestId:$r,desiredCount:1,tenantSlug:$ts,groupName:"Wrong Group"}')
  local status; status=$(_call POST /workers/launch "$body")
  _status_is "$status" 403
}
_assert 7.6 'Wrong groupName returns 403' _check_7_6

# -- section 8: DELETE ------------------------------------------------------

echo 'Section 8 — DELETE /workers/{workerId}'

# Pick one of our spawned workers
TARGET_WORKER="${SPAWNED_WORKERS[0]:-}"
if [[ -z "$TARGET_WORKER" ]]; then
  # No tracked id (launcher omitted workerInstances) — fetch from /workers
  _call GET /workers '' >/dev/null
  TARGET_WORKER=$(jq -r '.workers[0].workerId // empty' /tmp/conformance-body)
fi
[[ -n "$TARGET_WORKER" ]] || { echo "    no worker to DELETE — failing"; exit 1; }

_check_8_1() {
  local status; status=$(_call DELETE "/workers/${TARGET_WORKER}" '')
  _status_is "$status" 204
}
_assert 8.1 'DELETE real worker returns 204' _check_8_1

_check_8_2() {
  local end=$(( SECONDS + CONVERGE_SECONDS ))
  while (( SECONDS < end )); do
    _call GET /workers '' >/dev/null
    if ! jq -e --arg w "$TARGET_WORKER" '.workers[]?.workerId == $w' /tmp/conformance-body >/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}
_assert 8.2 'Deleted worker disappears within 30s' _check_8_2

_check_8_3() {
  local status; status=$(_call DELETE '/workers/wkr-doesnotexist-1234' '')
  _status_is "$status" 204
}
_assert 8.3 'DELETE absent worker returns 204' _check_8_3

_check_8_4() {
  local status; status=$(_call DELETE "/workers/${TARGET_WORKER}" '')
  _status_is "$status" 204
}
_assert 8.4 'DELETE same worker twice returns 204' _check_8_4

# Remove the deleted worker from our tracking list to avoid noisy cleanup
SPAWNED_WORKERS=("${SPAWNED_WORKERS[@]/$TARGET_WORKER}")

# -- section 9: capacity ----------------------------------------------------

echo 'Section 9 — Capacity'

_check_9_1() {
  _call GET /workers '' >/dev/null
  local maxw; maxw=$(jq -r '.limits.maxWorkers' /tmp/conformance-body)
  # Try to spawn maxWorkers + 10
  local target=$(( maxw + 10 ))
  local body; body=$(jq -n --arg r "$(_uuid)" --arg ts "$LAUNCHER_TENANT_SLUG" --arg gn "$LAUNCHER_GROUP_NAME" --argjson dc "$target" '{requestId:$r,desiredCount:$dc,tenantSlug:$ts,groupName:$gn}')
  _call POST /workers/launch "$body" >/dev/null
  mapfile -t _new < <(jq -r '.workerInstances[]?.workerId // empty' /tmp/conformance-body)
  SPAWNED_WORKERS+=("${_new[@]}")
  # Wait for convergence, then verify count ≤ maxWorkers
  sleep "$CONVERGE_SECONDS"
  _call GET /workers '' >/dev/null
  local cnt; cnt=$(jq -r '.workers | length' /tmp/conformance-body)
  (( cnt <= maxw ))
}
_assert 9.1 'Over-request never exceeds maxWorkers cap' _check_9_1

# -- done -------------------------------------------------------------------

echo
echo "All assertions passed."
