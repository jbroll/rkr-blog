#!/usr/bin/env bash
# verify-deploy.sh — post-deploy smoke check for a rkr-blog site.
# Confirms the deploy took (health hash) and that the OAuth-gated
# integration routes actually registered. A /status endpoint that 404s
# means the server booted without that provider's env vars — the
# Connect button for it will 404 too. Probed logged-out on purpose:
# an unregistered route 404s for everyone, while a registered one
# 401s without a session. No auth needed, nothing is modified.
#
# Usage:
#   scripts/verify-deploy.sh https://code.rkroll.com [--expect-gdrive] [--expect-onedrive] [--expect-gphotos] [--expect-hash <sha>]
#
# Exit 0 iff /health is 200 and every --expect-* flag is satisfied.
# Any other status code on a probed endpoint is a hard failure.

set -euo pipefail

BASE="${1:-http://127.0.0.1:3000}"
shift || true

EXPECT_GDRIVE=0
EXPECT_ONEDRIVE=0
EXPECT_GPHOTOS=0
EXPECT_HASH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-gdrive) EXPECT_GDRIVE=1 ;;
    --expect-onedrive) EXPECT_ONEDRIVE=1 ;;
    --expect-gphotos) EXPECT_GPHOTOS=1 ;;
    --expect-hash)
      shift
      EXPECT_HASH="${1:?--expect-hash needs a value}"
      ;;
    *)
      echo "verify-deploy: unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

failures=0

code_of() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$1"
}

# --- build hash -----------------------------------------------------------
health_code="$(code_of "$BASE/health")"
if [[ "$health_code" != "200" ]]; then
  echo "FAIL $BASE/health -> $health_code (want 200)"
  failures=$((failures + 1))
else
  hash="$(curl -s --max-time 15 "$BASE/health" | grep -o '"gitHash":"[^"]*"' | cut -d'"' -f4)"
  echo "ok   $BASE/health -> 200 gitHash=${hash:-unknown}"
  if [[ -n "$EXPECT_HASH" && "$hash" != "$EXPECT_HASH"* ]]; then
    echo "FAIL gitHash $hash does not start with $EXPECT_HASH"
    failures=$((failures + 1))
  fi
fi

# --- integration routes ----------------------------------------------------
# Logged-out probe: 401 = route registered (auth gate holding),
# 404 = route absent (provider env missing at boot).
check_provider() {
  local name="$1" path="$2" expect="$3"
  local code
  code="$(code_of "$BASE$path")"
  local state
  case "$code" in
    401) state="registered" ;;
    404) state="NOT REGISTERED" ;;
    *)
      echo "FAIL $path -> $code (want 401 or 404)"
      failures=$((failures + 1))
      return
      ;;
  esac
  if [[ "$expect" == "1" && "$code" != "401" ]]; then
    echo "FAIL $name: $state (expected registered — provider env missing at boot?)"
    failures=$((failures + 1))
  else
    echo "ok   $name: $state"
  fi
}

check_provider "gdrive" "/admin/integrations/gdrive/status" "$EXPECT_GDRIVE"
check_provider "onedrive" "/admin/integrations/onedrive/status" "$EXPECT_ONEDRIVE"
check_provider "gphotos" "/admin/integrations/gphotos/status" "$EXPECT_GPHOTOS"

if [[ "$failures" -gt 0 ]]; then
  echo "verify-deploy: $failures check(s) failed"
  exit 1
fi
echo "verify-deploy: all checks passed"
