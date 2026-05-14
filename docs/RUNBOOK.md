# Operator runbook

Procedures for the live-site operator, not the day-to-day developer.
Day-to-day setup is in [`developer-quickstart.md`](developer-quickstart.md).

## Reset → seed → walk

The end-to-end "wipe a site, repopulate from a WordPress source, verify
every post and image renders" cycle. Use this:

- After landing a release on the demo and wanting a clean baseline.
- After an import-pipeline change, to confirm a known WP fixture
  round-trips end-to-end on real infrastructure.
- After a Fly redeploy, to confirm the volume + machine survived the
  swap and the public surface is healthy.

The same three commands apply to both targets — only the base URL and
the auth source change.

### Targets

| Target            | Base URL                                | `ADMIN_TOKEN` source                       |
|-------------------|-----------------------------------------|--------------------------------------------|
| Local dev         | `http://127.0.0.1:3000` (or your `PORT`)| your `.env` / shell — whatever you started the server with |
| Remote (Fly demo) | `https://rkr-blog.fly.dev`              | repo's `secret.env` (gitignored) — `set -a; . secret.env; set +a` exposes `ADMIN_TOKEN`. Fly itself reads the same value from `fly secrets list --app rkr-blog`. |

`fly.toml` pins the public URL to `rkr-blog.fly.dev`; `rkr-blog.fly.io`
redirects but isn't the canonical host.

### 1. Reset

Wipes posts, originals, sidecars, and cached derivatives on the target.
Idempotent — the only side effect is "everything is gone, again."

```bash
# Local dev
SITE_ROOT=$HOME/site bin/site-admin reset \
  --to http://127.0.0.1:3000 --token "$ADMIN_TOKEN" --force

# Fly demo
bin/site-admin reset \
  --to https://rkr-blog.fly.dev --token "$ADMIN_TOKEN" --force
```

`--force` is required; without it the CLI prints a warning and exits
non-zero. The token is read from `--token` or `$ADMIN_TOKEN`.

A successful reset prints:

```
reset ok: posts=N, originals=N, sidecars=N, cache=N (db rows cleared: N)
```

The Fly volume keeps directory shells around — empty
`originals/<aa>/<bb>/` shard dirs are expected after a reset; the actual
blob files are gone. `bin/site-admin gc` will tidy them later.

### 2. Seed (import 3 posts from a WordPress source)

`site-admin import-wp` has three subcommands; the operator path uses
`list` + `push`:

```bash
# (a) discover what's available
bin/site-admin import-wp list <wp-base-url> --per-page 10

# Output: numbered list of (id, slug, date, title) tuples for the
# latest published posts on the WP site.

# (b) push three slugs to the target
for slug in slug-a slug-b slug-c; do
  bin/site-admin import-wp push <wp-base-url> "$slug" \
    --to <target-url> --token "$ADMIN_TOKEN"
done
```

Each `push` invocation:

1. Fetches the WP REST payload for the slug.
2. Runs the local importer into a temp directory (extracts every
   `<img>`, ingests the bytes, emits `::figure` directives in markdown).
3. Uploads each unique original to `<target>/admin/upload` (multipart,
   bearer auth).
4. POSTs the markdown body to `<target>/admin/posts` (JSON, bearer
   auth) with `status=published`.
5. Cleans up the temp directory.

Output per slug: `pushed <slug> (inserted): images=N (failed=0)`.

The target's `<target>/admin/upload` is bearer-auth only — the bearer
token is the same `ADMIN_TOKEN` the reset step used.

### 3. Walk (verify)

`scripts/walk-site.sh` traverses every published post on the target,
fetches each post's HTML, and HEADs every image referenced from it.
No auth needed — everything walked here is public.

```bash
# Local dev
scripts/walk-site.sh http://127.0.0.1:3000

# Fly demo
scripts/walk-site.sh https://rkr-blog.fly.dev
```

Output:

```
==> https://rkr-blog.fly.dev — 3 posts across 1 page(s)
post-slug-a                              200 Title A · imgs=4 failed=0
post-slug-b                              200 Title B · imgs=2 failed=0
post-slug-c                              200 Title C · imgs=7 failed=0
----
summary: posts=3 post_failures=0 images=13 image_failures=0
```

Exit 0 only if every post returned 2xx and every image HEADed 2xx.
Non-zero post or image counts on the failure line trigger exit 1.

The walk follows pagination from `/?page=1` until a page yields no
slugs, so it covers every published post — useful well beyond the
3-post seed flow.

### 4. End-to-end smoke (full cycle)

For the canonical seed (`roll-along.rkroll.com` → target), the
reset+copy step is bundled into one script:

```bash
TARGET=https://rkr-blog.fly.dev   # or http://127.0.0.1:3000
ADMIN_TOKEN=...                   # bearer matching the target

scripts/reseed-from-roll-along.sh "$TARGET" 3
scripts/walk-site.sh "$TARGET"
```

The WP source is hardcoded in the reseed script — for a different WP
source, fall back to the three-step form:

```bash
bin/site-admin reset --to "$TARGET" --token "$ADMIN_TOKEN" --force

mapfile -t slugs < <(bin/site-admin import-wp list "$WP_BASE" --per-page 3 \
  | awk '/^[0-9]+ /{ print $2 }')

for slug in "${slugs[@]}"; do
  bin/site-admin import-wp push "$WP_BASE" "$slug" \
    --to "$TARGET" --token "$ADMIN_TOKEN"
done

scripts/walk-site.sh "$TARGET"
```

If walk-site exits 0, the reset + seed + render path is healthy.

A walk over an image-heavy seed will trip the per-IP rate limit on
`/img/:filename` (120 req/min). The walk script handles this
transparently — on a 429 it sleeps until `x-ratelimit-reset` and
retries once — but the wall-clock time scales with how often it has to
back off. A 125-image seed lands in ~60s; budget accordingly.

### 5. Refresh a single slug

A full reset wipes every post on the target. When a bug only repros
on one specific slug — say, after a `wp-import` change — overwriting
that single post is faster and leaves the other demo posts in place:

```bash
bin/site-admin import-wp push "$WP_BASE" first-2-days-on-the-boats \
  --to "$TARGET" --token "$ADMIN_TOKEN"
```

The remote `/admin/posts` accepts the slug in-place: the response
`inserted: false` confirms an overwrite (vs. `true` for a fresh
insert). The new image originals are content-addressed, so re-pushing
the same bytes is a dedup hit on the target.

Caveat: image IDs that the *previous* version of the post referenced
but the *new* version doesn't end up orphaned in `originals/` +
`sidecars/`. Run `bin/site-admin gc` (against the target) to reclaim
them; the next scheduled gc on Fly does this automatically.

### 6. Check image orientations

`walk-site.sh` only HEADs each image for a 2xx — a photo rendered
sideways still resolves, so the walk can't catch rotation regressions.
`scripts/check-orientation.mjs` cross-references the target's rendered
image bytes against the WP source's `<img width="…" height="…">`
declarations and flags any pair whose landscape ↔ portrait
orientation flipped:

```bash
# All posts on the target
scripts/check-orientation.mjs "$WP_BASE" "$TARGET"

# Just the slug under investigation
scripts/check-orientation.mjs "$WP_BASE" "$TARGET" first-2-days-on-the-boats
```

Exit codes: 0 if every paired image's orientation matches, 1 if any
flipped (regression), 2 if a post couldn't be retrieved from either
end. Per-image FAIL lines name the slug, image index, and both pairs
of dimensions:

```
first-2-days-on-the-boats img[0] FAIL: wp=768×1024 (portrait) target=1200×900 (landscape) /img/4074552f….jpeg
```

Aspect comparison is intentionally coarse — landscape vs. portrait vs.
square (with a 5% square tolerance). The render pipeline resizes
freely; only an orientation flip indicates the rotation pipeline lost
information.

Recommended cadence: run after every `wp-import` change, and after
any reseed of the canonical demo. Bare-bones eyeball still wins for
non-rotation regressions (cropping, colour shifts), but this catches
the specific class of bug (`srcset` parsing dropping a `-rotated.jpeg`
variant) that surfaced on /first-2-days-on-the-boats.

### 7. Filesystem reset (local dev)

`bin/site-admin reset` is HTTP-based and requires a running server.
When the server itself is in a weird state (mid-migration, lock-file
left over, port conflict from a runaway test process), wipe directly
on disk and reinitialize:

```bash
SITE_ROOT="${SITE_ROOT:-$HOME/site}"
rm -rf "$SITE_ROOT"/{content,originals,sidecars,cache,data}
bin/site-admin init       # recreates the dir tree + runs migrations
```

`init` is idempotent: it only generates `data/secret.key` when absent,
so existing sessions survive a re-run (provided you preserved that
file). The other writable subtrees — `content/posts`, `originals`,
`sidecars`, `cache/img`, `data` — are recreated empty.

Never use this on the Fly demo. The Fly volume isn't a local
filesystem you can rm + reinit; the HTTP `bin/site-admin reset
--to https://rkr-blog.fly.dev …` path is the only safe wipe there.

## Fly machine sizing

The Fly demo's VM size lives in `fly.toml` (`[[vm]]` block), not in
the Fly dashboard. Fly's UI exposes start/stop/restart but resizing
goes through the deployed config:

```toml
[[vm]]
  size = "shared-cpu-2x"
  memory = "2gb"
```

Edit, commit, push. The GitHub-app integration auto-deploys this
branch on push; the new machine spec rolls out with the next
deploy. The previous machine is replaced (not scaled alongside) —
brief downtime during the roll is expected.

When to bump: image-render bursts (`/img/<id>.<hash>.<fmt>`) trip
OOM during the post-reseed pre-warm. Each variant render decodes
the source JPEG into uncompressed pixel buffers before resizing,
and a 24-image post at 12-MP source resolution × multiple variants
× multiple output formats burns through 512 MB quickly. 2 GB is a
comfortable floor for the current photo-heavy demo seed; if a
single image's source resolution is in the high tens of megapixels,
bump further.

`fly status --app rkr-blog` confirms the current size; `fly logs
--app rkr-blog` shows the kernel OOM message when the cap is hit
(`Killed (out of memory)`).

## Troubleshooting

- **`reset failed: 401 invalid token`** — The bearer token doesn't
  match `ADMIN_TOKEN` on the target. For Fly, `fly secrets list --app
  rkr-blog` shows the digest but not the value; if it's drifted from
  your local copy, set a fresh one with `fly secrets set
  ADMIN_TOKEN=<new>` and remember to update the runner.
- **`POST /admin/upload: 413`** — The target rejected an image as too
  large. Source has an oversize asset; either clean it up upstream or
  raise the multipart limit in `src/server.ts`.
- **`render failed` (HTTP 500 from `/img/<id>.<hash>.<fmt>`)** — sharp
  threw on the derivative. Almost always a corrupt or pathologically
  small original. The walk script reports it as a per-image failure;
  check `fly logs --app rkr-blog` for the underlying sharp error.
- **Walk reports `posts=0`** — Either the import didn't run (check
  `import-wp push` exit codes) or the posts landed as `draft` (default
  is `published`; `--status draft` overrides).
