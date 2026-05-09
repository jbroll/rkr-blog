#!/usr/bin/env bash
# reseed-from-roll-along.sh — reset a rkroll-cms target and re-seed it
# from roll-along.rkroll.com (the WordPress source for this project).
#
# WP source is hardcoded by design — this script is the operator's
# one-shot for "wipe the demo and repopulate with the canonical seed."
# For a different WP source, use `bin/site-admin reset` +
# `bin/site-admin import-wp push` directly (see RUNBOOK.md).
#
# Usage:
#   scripts/reseed-from-roll-along.sh <target-url> [post-count]
#
# Examples:
#   ADMIN_TOKEN=xxx scripts/reseed-from-roll-along.sh https://rkr-blog.fly.dev
#   ADMIN_TOKEN=xxx scripts/reseed-from-roll-along.sh http://127.0.0.1:3000 5
#
# Env:
#   ADMIN_TOKEN   required — bearer token matching the target's
#                 ADMIN_TOKEN env var.
#
# After it succeeds, run scripts/walk-site.sh against the same target
# to verify every post + image renders.

set -euo pipefail

WP_BASE="https://roll-along.rkroll.com"

target="${1:-}"
count="${2:-3}"

if [ -z "$target" ]; then
  echo "usage: $0 <target-url> [post-count, default 3]" >&2
  echo "       (set ADMIN_TOKEN in env)" >&2
  exit 2
fi
if [ -z "${ADMIN_TOKEN:-}" ]; then
  echo "ADMIN_TOKEN must be set in env" >&2
  exit 2
fi

target="${target%/}"
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cli="$repo_root/bin/site-admin"

echo "==> source: $WP_BASE"
echo "==> target: $target"
echo "==> count:  $count"
echo

# 1. Reset the target. The CLI requires --force; without it the call
#    refuses with a "this is destructive" message.
echo "==> reset"
"$cli" reset --to "$target" --token "$ADMIN_TOKEN" --force

# 2. Discover the latest N published slugs on the WP source. The REST
#    `_fields` parameter trims the response to ids/slugs/titles so we
#    don't pull full post bodies just to enumerate them.
echo "==> listing $count slug(s) from $WP_BASE"
mapfile -t slugs < <(
  curl -fsS "$WP_BASE/wp-json/wp/v2/posts?per_page=$count&_fields=slug&status=publish" \
    | python3 -c 'import json,sys; [print(p["slug"]) for p in json.load(sys.stdin)]'
)
if [ "${#slugs[@]}" -eq 0 ]; then
  echo "no slugs returned from $WP_BASE — aborting" >&2
  exit 1
fi
printf '   - %s\n' "${slugs[@]}"

# 3. Push each slug. Sequential so a partial-batch failure stops cleanly
#    rather than leaving the target in a half-seeded state.
echo "==> push"
for slug in "${slugs[@]}"; do
  echo "   pushing $slug"
  "$cli" import-wp push "$WP_BASE" "$slug" \
    --to "$target" --token "$ADMIN_TOKEN"
done

echo
echo "==> reseed complete — ${#slugs[@]} post(s) pushed"
echo "    next: scripts/walk-site.sh $target"
