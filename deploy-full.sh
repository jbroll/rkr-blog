#!/bin/bash
# deploy-full.sh — deploy the rkr-blog fleet and verify each site.
#
# Sites (see docs/RUNBOOK.md "Deploying a site"):
#   rkr-blog      roll-along.rkroll.com, admin on rkr-blog.rkroll.com
#   stockademade  stockademade.com
#   code          code.rkroll.com
#   website       rkr-blog-www.rkroll.com (static, separate deploy)
#
# Usage: ./deploy-full.sh [rkr-blog|stockademade|code|website|all] [init|update]
#
# Each app deploy is followed by scripts/verify-deploy.sh against the
# live host: --expect-<provider> flags are derived from the site's own
# deploy/secrets/<site>.secrets.env (non-empty values only), so verify
# fails when the server booted without env the operator already
# configured locally. --expect-hash pins the just-deployed commit, and
# is skipped with a warning when the working tree is dirty (what ships
# then isn't HEAD, so pinning to HEAD would false-fail).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Sibling projects address deploy.sh as ../deploy.sh; allow override for
# testing (e.g. DEPLOY_SH=/tmp/stub-deploy.sh ./deploy-full.sh code).
DEPLOY_SH="${DEPLOY_SH:-../deploy.sh/deploy.sh}"

SITE="${1:-all}"
MODE="${2:-update}"

case "$SITE" in
  rkr-blog | stockademade | code | website | all) ;;
  *)
    echo "Usage: $0 [rkr-blog|stockademade|code|website|all] [init|update]" >&2
    exit 2
    ;;
esac

case "$MODE" in
  init | update) ;;
  *)
    echo "Usage: $0 [rkr-blog|stockademade|code|website|all] [init|update]" >&2
    exit 2
    ;;
esac

if [[ ! -x "$DEPLOY_SH" ]]; then
  echo "deploy-full: deploy.sh not found at $DEPLOY_SH" >&2
  exit 1
fi

# Pin the serving commit when the tree is clean; a dirty tree ships
# bytes that aren't HEAD, so hashing HEAD would false-fail.
EXPECT_HASH=""
if git rev-parse HEAD >/dev/null 2>&1; then
  if [[ -z "$(git status --porcelain)" ]]; then
    EXPECT_HASH="$(git rev-parse HEAD)"
  else
    echo "deploy-full: working tree dirty — skipping --expect-hash (ships non-HEAD bytes)"
  fi
fi

# Non-empty value for KEY in the site's secrets file? (Key names only;
# values never leave the file.)
secret_set() {
  grep -qE "^${2}=[^[:space:]]" "deploy/secrets/${1}.secrets.env" 2>/dev/null
}

# Probe base: the admin host when the site splits hostnames (its
# /admin/* probes would otherwise 308 to the alias and confuse the
# check), else the public URL.
probe_base() {
  local admin public
  admin="$(grep -E '^ADMIN_BASE_URL=' "deploy/sites/${1}.env" | tail -n1 | cut -d= -f2- || true)"
  public="$(grep -E '^PUBLIC_BASE_URL=' "deploy/sites/${1}.env" | tail -n1 | cut -d= -f2- || true)"
  if [[ -n "$admin" ]]; then
    echo "$admin"
  else
    echo "$public"
  fi
}

deploy_app_site() {
  local site="$1"
  local base expect=()
  base="$(probe_base "$site")"
  if secret_set "$site" "GOOGLE_CLIENT_ID" && secret_set "$site" "GOOGLE_CLIENT_SECRET"; then
    expect+=(--expect-gdrive --expect-gphotos)
  fi
  if secret_set "$site" "MICROSOFT_CLIENT_ID" && secret_set "$site" "MICROSOFT_CLIENT_SECRET"; then
    expect+=(--expect-onedrive)
  fi
  echo "=== $site ($base) mode=$MODE ==="
  DEPLOY_SH_CONF="deploy/sites/${site}.conf" "$DEPLOY_SH" "$MODE" .
  echo "--- verify $site ---"
  if [[ -n "$EXPECT_HASH" ]]; then
    scripts/verify-deploy.sh "$base" "${expect[@]}" --expect-hash "$EXPECT_HASH"
  else
    scripts/verify-deploy.sh "$base" "${expect[@]}"
  fi
  echo ""
}

deploy_website() {
  echo "=== website (rkr-blog-www.rkroll.com) mode=$MODE ==="
  "$DEPLOY_SH" "$MODE" website/
  echo "--- verify website ---"
  curl -sf -o /dev/null --max-time 15 https://rkr-blog-www.rkroll.com/ \
    && echo "ok   website: 200"
  echo ""
}

case "$SITE" in
  rkr-blog | stockademade | code) deploy_app_site "$SITE" ;;
  website) deploy_website ;;
  all)
    deploy_app_site rkr-blog
    deploy_app_site stockademade
    deploy_app_site code
    deploy_website
    ;;
esac

echo "=== deploy-full: $SITE ($MODE) complete ==="
