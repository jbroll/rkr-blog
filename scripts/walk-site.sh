#!/usr/bin/env bash
# walk-site.sh — visit every published post on a rkroll-cms instance and
# verify each post's images resolve. Operator smoke tool — no auth needed
# (everything walked here is public). Exits non-zero if any post or image
# returns a non-2xx, so it composes into CI/runbook checks.
#
# Usage:
#   scripts/walk-site.sh [BASE_URL]
#
# Defaults to http://127.0.0.1:3000 if no BASE_URL is given. Walks the
# paginated index from /?page=1 onward until pagination ends, fetches
# each post's HTML, and HEADs every <img src="/img/..."> reference.
#
# Output:
#   one line per post: <slug> · <http-status> · <title> · imgs=N (failed=M)
#   plus a final summary. Exit 0 iff every post and every image returned 2xx.

set -euo pipefail

BASE="${1:-http://127.0.0.1:3000}"
BASE="${BASE%/}"

# Temp files for grep/sort/uniq pipework (xargs over here-strings is
# unreliable across bash versions).
tmp=$(mktemp -d -t rkr-walk-XXXXXX)
trap 'rm -rf "$tmp"' EXIT

slugs_file="$tmp/slugs"
: > "$slugs_file"

# 1. Walk paginated index. /?page=N returns 200 with an empty list past
#    the last page; we stop when a page yields zero new slugs.
page=1
total_pages_seen=0
while :; do
  page_html="$tmp/index-$page.html"
  http=$(curl -sS -o "$page_html" -w '%{http_code}' "$BASE/?page=$page")
  if [ "$http" != "200" ]; then
    echo "ERROR: GET $BASE/?page=$page -> $http" >&2
    exit 2
  fi
  # Index links live in <ul class="post-list">…<li><a href="/<slug>">…
  # Filter to root-relative single-segment hrefs that aren't /img/ or /static/.
  new_slugs=$(grep -oE 'href="/[^"/]+"' "$page_html" \
    | sed -E 's|href="/([^"]+)"|\1|' \
    | grep -vE '^(static|admin|img|$)' || true)
  if [ -z "$new_slugs" ]; then break; fi
  echo "$new_slugs" >> "$slugs_file"
  total_pages_seen=$((total_pages_seen + 1))
  page=$((page + 1))
  # Safety: don't loop forever on a misbehaving paginator.
  if [ "$page" -gt 200 ]; then
    echo "ERROR: pagination did not terminate at page 200" >&2
    exit 2
  fi
done

# Dedup — pagination overlap or a slug appearing twice would otherwise
# inflate the per-image checks.
sort -u "$slugs_file" -o "$slugs_file"
post_count=$(wc -l < "$slugs_file" | tr -d ' ')

echo "==> $BASE — $post_count posts across $total_pages_seen page(s)"

post_failures=0
image_failures=0
total_images=0

while IFS= read -r slug; do
  [ -z "$slug" ] && continue
  body="$tmp/post-$slug.html"
  http=$(curl -sS -o "$body" -w '%{http_code}' "$BASE/$slug")
  title=$(grep -oE '<title>[^<]+</title>' "$body" \
    | head -1 \
    | sed -E 's|</?title>||g; s| — rkroll||')
  # Pull every <img src="…">. Restrict to /img/ derivatives — figure
  # widgets render <img src="/img/<id>__<ophash>.<fmt>">. Other <img>s
  # (icons, off-site embeds) shouldn't exist on a rkroll post but we
  # surface them in the count too.
  mapfile -t imgs < <(grep -oE '<img [^>]*src="[^"]+"' "$body" \
    | sed -E 's|.*src="([^"]+)".*|\1|' \
    | sort -u)
  img_count=${#imgs[@]}
  total_images=$((total_images + img_count))

  failed=0
  for src in "${imgs[@]}"; do
    # Resolve relative URLs to BASE so HEAD picks up site-root paths.
    case "$src" in
      http://*|https://*) url="$src" ;;
      /*)                 url="$BASE$src" ;;
      *)                  url="$BASE/$src" ;;
    esac

    # Retry-with-backoff mirroring src/site/img-retry.ts: 3 attempts at
    # 500/2000/8000 ms with ±20% jitter. The browser does the same on
    # cold-cache 5xx and on edge timeouts (Fly returns 502 when sharp
    # blows the 30s render budget on a fresh derivative). 429 is a
    # separate branch that consults x-ratelimit-reset instead, since
    # the rate-limiter tells us exactly when the next slot opens.
    headers="$tmp/img-$slug.hdr"
    attempts_remaining=3
    img_http="000"
    while :; do
      img_http=$(curl -sS -L -o /dev/null -D "$headers" -w '%{http_code}' -I "$url" || echo "000")
      case "$img_http" in 2*) break ;; esac
      [ "$attempts_remaining" -le 0 ] && break
      attempts_remaining=$((attempts_remaining - 1))
      attempt_idx=$((3 - attempts_remaining))    # 1 → 2 → 3
      if [ "$img_http" = "429" ]; then
        reset=$(awk 'tolower($1)=="x-ratelimit-reset:" { sub(/\r$/,"",$2); print $2; exit }' "$headers")
        sleep_for="${reset:-2}"
        [ "$sleep_for" -gt 0 ] 2>/dev/null || sleep_for=2
      else
        case "$attempt_idx" in
          1) base_ms=500  ;;
          2) base_ms=2000 ;;
          *) base_ms=8000 ;;
        esac
        sleep_for=$(awk -v b="$base_ms" 'BEGIN { srand(); j = (rand()*0.4 - 0.2); printf "%.3f", (b * (1+j)) / 1000 }')
      fi
      sleep "$sleep_for"
    done

    case "$img_http" in
      2*) ;;
      *)  failed=$((failed + 1))
          echo "    img FAIL $img_http  $url" >&2 ;;
    esac
  done
  image_failures=$((image_failures + failed))

  case "$http" in
    2*) status_label="$http" ;;
    *)  status_label="$http"; post_failures=$((post_failures + 1)) ;;
  esac
  printf '%-40s %3s %s · imgs=%d failed=%d\n' \
    "$slug" "$status_label" "${title:-(no title)}" "$img_count" "$failed"
done < "$slugs_file"

echo "----"
echo "summary: posts=$post_count post_failures=$post_failures images=$total_images image_failures=$image_failures"
if [ "$post_failures" -gt 0 ] || [ "$image_failures" -gt 0 ]; then
  exit 1
fi
