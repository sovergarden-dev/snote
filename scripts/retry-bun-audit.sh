#!/usr/bin/env bash
# Retry bun audit on transient registry/network errors only.
# Real high/critical findings still fail the job without extra attempts.
set -euo pipefail

MAX_ATTEMPTS=5
SLEEP_SECONDS=15
# bun's HTTP idle timeout defaults to 300s. A Timeout flake would then spend
# ~25 minutes inside quality (20m) / extension-e2e (15m). GitHub runners often
# need ~30s TTFB; 30s idle was racing successful audits. 60s still fail-fast.
export BUN_CONFIG_HTTP_IDLE_TIMEOUT=60

# Bun prints "Timeout: audit request failed" / "ConnectionClosed: audit request
# failed" / "error: audit request failed (status N)". Do not match bare
# "Timeout" — advisory titles can contain it (e.g. p-timeout).
TRANSIENT_PATTERN='audit request failed|ConnectionClosed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|getaddrinfo'
ADVISORY_PATTERN='GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}|^[[:space:]]*(high|critical):'

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  set +e
  bun audit --audit-level=high --ignore=GHSA-vfj7-8cjw-p6xm 2>&1 | tee "$log"
  status="${PIPESTATUS[0]}"
  set -e

  if [ "$status" -eq 0 ]; then
    exit 0
  fi

  if [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
    exit "$status"
  fi

  if grep -Eqi "$ADVISORY_PATTERN" "$log"; then
    exit "$status"
  fi

  if grep -Eqi "$TRANSIENT_PATTERN" "$log"; then
    echo "Transient bun audit error (attempt ${attempt}/${MAX_ATTEMPTS}); retrying in ${SLEEP_SECONDS}s..." >&2
    sleep "$SLEEP_SECONDS"
    attempt=$((attempt + 1))
    continue
  fi

  exit "$status"
done
