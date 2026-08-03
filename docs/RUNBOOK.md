# Operator runbook

Procedures for the live-site operator, not the day-to-day developer.
Day-to-day setup is in [`developer-quickstart.md`](developer-quickstart.md).

## Deploying a site

Two sites are configured in this tree, each as its own systemd service.
Only roll-along is deployed — stockademade has a site config and DNS
pointing at the VPS but no vhost or service there yet.

| Site | Domain | `APP_NAME` | Port | Deployed |
|---|---|---|---|---|
| roll-along | roll-along.rkroll.com, admin on rkr-blog.rkroll.com | `rkr-blog` | 3000 | yes |
| stockademade | stockademade.com (`www.` 301s to apex) | `stockademade` | 3002 | no |

`APP_NAME` is `rkr-blog`, not `roll-along` — it names the unit and the
server-side paths, and predates the domain move. Renaming it would move
`/var/www/rkr-blog` and orphan the site's data.

### Split public / admin hostnames

roll-along serves both its hostnames directly — no canonical redirect —
with only `/admin` pinned to `rkr-blog.rkroll.com`. Sign-in has to start
and finish on one host: the OAuth state cookie is host-only, so a flow
begun on the public host loses it when the provider returns to the admin
host and the callback 400s.

These settings have to agree, and the tests in
`test/deploy/site-config.test.ts` check that they do:

| Setting | Where | roll-along |
|---|---|---|
| `DOMAIN_NAME` | `<site>.conf` | `roll-along.rkroll.com` |
| `APACHE_SERVER_ALIASES` | `<site>.conf` | `rkr-blog.rkroll.com` |
| `APACHE_CANONICAL_REDIRECT` | `<site>.conf` | `no` — serve aliases, don't 301 them |
| `APACHE_ADMIN_HOST` | `<site>.conf` | `rkr-blog.rkroll.com` — must be the domain or one of its aliases, or the cert won't cover it |
| `PUBLIC_BASE_URL` | `<site>.env` | `https://roll-along.rkroll.com` |
| `ADMIN_BASE_URL` | `<site>.env` | `https://rkr-blog.rkroll.com` |

Keeping `ADMIN_BASE_URL` on the original hostname is what lets the Google
and Microsoft clients stay as they are — every `redirect_uri` is built
from it. Moving it means re-authorising all three callbacks.

The CSRF guard follows the same split: the admin origin may POST
anywhere, the reader origin only outside `/admin`. Both hostnames sit
under `rkroll.com`, so `SameSite=Lax` would not stop a page on the
reader host from forging an admin POST on its own.

Neither base URL may appear in `deploy/secrets/<site>.secrets.env`:
secrets win the merge, so a stale copy there silently overrides the site
env. `fastify_app.build.post.sh` fails the deploy if it finds one.

```bash
# roll-along — deploy.conf defaults to it
~/src/deploy.sh/deploy.sh update .

# any other site
DEPLOY_SH_CONF=deploy/sites/stockademade.conf ~/src/deploy.sh/deploy.sh update .
```

Never pass a `user@host` argument; each site config sets `REMOTE_HOST` to
the VPS, and an argument overrides it.

### First deploy of a new site

1. Create a Google OAuth client for the host, authorised redirect URI
   `https://<domain>/admin/auth/google/callback`. One client per host.
   The Drive and OneDrive integrations add
   `https://<domain>/admin/integrations/gdrive/callback` and
   `.../onedrive/callback` on their own clients. All three derive from
   `ADMIN_BASE_URL` (which defaults to `PUBLIC_BASE_URL`), so changing a
   site's admin hostname means re-authorising every one of them.
2. `cp deploy/secrets.env.example deploy/secrets/<site>.secrets.env` and
   fill it in; generate `ADMIN_TOKEN` with `openssl rand -hex 32`.
3. Point DNS at the VPS — certbot's webroot challenge needs the name to
   resolve before `init` runs. If the site has `APACHE_SERVER_ALIASES`
   (e.g. stockademade's `www.`), that alias needs an A record too:
   certbot requests the apex and the alias as one SAN cert, so a missing
   alias record fails issuance and leaves the vhost SSL-stripped.
4. `DEPLOY_SH_CONF=deploy/sites/<site>.conf ~/src/deploy.sh/deploy.sh init .`
5. Verify: the unit is active, `https://<domain>/` returns 200, Google
   sign-in reaches the admin, and **the other sites are still up** — an
   `init` reloads Apache, so a broken vhost takes every site with it.
6. Confirm the sites are not sharing configuration:

   ```bash
   sudo grep -hE '^(SITE_ROOT|PUBLIC_BASE_URL|ADMIN_TOKEN|GOOGLE_CLIENT_ID)=' \
     /etc/rkr-blog.env /etc/<site>.env | sort | uniq -d
   ```

   Expected: no output. Any duplicate line means two sites share a value
   they must not — most damagingly `SITE_ROOT`, which would have them
   writing over each other.

Server-side paths all derive from `APP_NAME`: app `/opt/<APP_NAME>`, data
`/var/www/<APP_NAME>`, env `/etc/<APP_NAME>.env`, unit
`<APP_NAME>.service`.

## Authorized users

Google sign-in on its own grants nothing. The callback resolves the
verified identity against an invite allowlist in the site DB, and an
uninvited email gets a 403. There is no first-login-becomes-owner
bootstrap, so a fresh deployment has an empty allowlist and **nobody can
sign in with Google until an invite exists** — only `ADMIN_TOKEN` login
works. Invite your own email before your first login.

```bash
# on the VPS, as the service user, from /opt/<APP_NAME>
bin/site-admin user invite <email> [--role owner|editor]
bin/site-admin user list
bin/site-admin user remove <email>
```

`user remove` deletes the allowlist row and that user's sessions in one
transaction, so access ends immediately rather than at session expiry.
It does not delete the user row — a re-invite restores access to the
same account.

Roles are recorded but not enforced: an `editor` invite has the same
access as an `owner` today. See `DEFERRED.md`.

Two guards worth knowing when a login is rejected:

- Emails are NFKC-normalised and lowercased before every comparison, so
  an invite and a login that differ only in Unicode form still match.
- A new Google identity presenting an email that already belongs to a
  user from a different provider is refused rather than silently linked
  (`email already linked to another provider`). Cross-provider linking
  has no UI yet.

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

### Importing from a database backup

When the WordPress install is gone, the importer can read a
`mariadb-dump` file plus the site's uploads tree instead. Convert the
dump once:

```bash
bin/site-admin wp-dump ../roll-along/db/rollalong.sql /tmp/rollalong.db
```

Then pass `--from-dump` and `--uploads` to any `import-wp` subcommand.
The base-URL argument is still required, but it only labels output:
nothing is fetched over the network, and the `source_url` in the emitted
frontmatter comes from the backup's own recorded site URL (`home`) and
`permalink_structure`:

```bash
UPLOADS=../roll-along/site/wp-content/uploads

bin/site-admin import-wp list https://roll-along.rkroll.com \
  --from-dump /tmp/rollalong.db --uploads "$UPLOADS" --status any

bin/site-admin import-wp push https://roll-along.rkroll.com one-final-day \
  --to https://rkr-blog.rkroll.com --token "$ADMIN_TOKEN" \
  --from-dump /tmp/rollalong.db --uploads "$UPLOADS"
```

A WordPress draft has no stored slug — WordPress leaves `post_name`
empty until a post is first published — so `import-wp list --status
draft` prints one derived from the title. That derived slug works
directly with `post` and `push`.

`--status draft` on `push` lands the post unpublished. A WP draft is
never published without an explicit `--status published`.

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

The canonical seed script is dead: `roll-along.rkroll.com` now serves
this app rather than the WordPress site it imported from, so
`reseed-from-roll-along.sh` would re-import the app from itself. Repoint
`WP_BASE` at an archive, or use the three-step form:

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

### 5a. Repair entity-encoded titles

Posts imported before the WP importer decoded HTML entities kept
WordPress's encoded form in their frontmatter — `title: "Day 12 &#8211;
31 Years!"`. The renderer escapes titles on output, so the entity
reaches the browser literally. `parsePost` deliberately does not decode
(that would put live `<`/`>`/`"` into in-memory titles), so the fix is
to rewrite the stored file:

```bash
# on the host, against the live content tree
site-admin fix-wp-titles /var/www/rkr-blog --dry-run   # list every change
site-admin fix-wp-titles /var/www/rkr-blog             # apply
site-admin reindex                                     # refresh the SQLite index
```

Only `title:` and `subtitle:` inside the frontmatter block are touched;
bodies are left alone. There is no provenance filter — posts pushed
through `/admin/posts` carry no `source_kind` — so read the `--dry-run`
output before applying. (For the same reason, `fix-wp-dates`, which does
gate on `source_kind: wordpress`, is a no-op on pushed posts.)

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
  `import-wp push` exit codes) or the posts landed as `draft`. Without
  `--status`, the target status follows the WordPress post: `publish`
  imports as `published`, anything else (including the drafts a
  `--from-dump` backup exposes) as `draft`. Pass `--status published`
  to override.
