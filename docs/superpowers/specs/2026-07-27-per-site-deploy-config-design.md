# Per-site deploy config

Run three rkr-blog instances from one code tree: the existing demo plus
the two sites taking over from WordPress.

| | rkr-blog | roll-along | stockademade |
|---|---|---|---|
| `APP_NAME` | `rkr-blog` | `roll-along` | `stockademade` |
| `DOMAIN_NAME` | `rkr-blog.rkroll.com` | `roll-along.rkroll.com` | `stockademade.com` |
| `APACHE_SERVER_ALIASES` | — | — | `www.stockademade.com` |
| `FASTIFY_APP_PORT` | 3000 | 3001 | 3002 |

`stockademade.com` is canonical; `www.stockademade.com` is a SAN on the
same certificate and redirects to the apex. Each site gets its own Google
OAuth client and its own `ADMIN_TOKEN`.

## Why nothing in deploy.sh changes

Every server-side name already derives from `APP_NAME`: app tree
`/opt/<APP_NAME>`, data `/var/www/<APP_NAME>`, env file
`/etc/<APP_NAME>.env`, unit `<APP_NAME>.service`, staging
`/tmp/<APP_NAME>-staging` (`modules/node_app/install.sh`,
`configure.sh`). The repo's Apache hook templates on `APP_NAME`,
`DOMAIN_NAME`, and `FASTIFY_APP_PORT` already.

`deploy.sh` reads `${DEPLOY_SH_CONF:-$project_dir/deploy.conf}`
(`deploy.sh:232`), so a site is selected by pointing that variable at a
different config file. One process serves one site — `SITE_ROOT` is a
single env var and `src/lib/config.ts` caches per process — so three
sites means three services, not one multi-tenant server.

## Layout

```
deploy.conf                      # shim: sources deploy/sites/rkr-blog.conf
deploy/
  common.conf                    # shared exports
  sites/rkr-blog.conf            # per-site identity
  sites/rkr-blog.env             # per-site non-secret runtime config
  sites/roll-along.conf
  sites/roll-along.env
  sites/stockademade.conf
  sites/stockademade.env
  secrets/rkr-blog.secrets.env   # gitignored
  secrets/roll-along.secrets.env
  secrets/stockademade.secrets.env
  secrets.env.example            # unchanged, now the template for the above
  hooks/                         # shared across all three sites
```

`deploy/config.env` moves to `deploy/sites/rkr-blog.env`. The root
`deploy.conf` shim keeps `deploy.sh update .` deploying the demo, which
is what the operator's muscle memory and existing notes assume.

### `deploy/common.conf`

Everything identical across sites: `DEPLOY_TYPES`, `REMOTE_USER`,
`LETSENCRYPT_EMAIL`, the `APACHE_*` switches, and all `FASTIFY_APP_*`
paths, policies, and Node options. No `APP_NAME`, `DOMAIN_NAME`,
`REMOTE_HOST`, or port.

### `deploy/sites/<site>.conf`

```bash
source "$(dirname "${BASH_SOURCE[0]}")/../common.conf"

export APP_NAME="roll-along"
export DOMAIN_NAME="roll-along.rkroll.com"
export REMOTE_HOST="rkr-blog.rkroll.com"
export FASTIFY_APP_PORT="3001"
export SITE_ENV_FILE="deploy/sites/roll-along.env"
export FASTIFY_APP_SECRETS_FILE="deploy/secrets/roll-along.secrets.env"
```

`SITE_ENV_FILE` and `FASTIFY_APP_SECRETS_FILE` are both repo-relative;
`node_app/build.sh` resolves the secrets file against `$PROJECT_DIR`
(`build.sh:13`), and the hook change below resolves the env file the
same way.

`REMOTE_HOST` is the VPS, not the site's public domain — all three land
on the same machine. As today, never pass `user@host` on the command
line; it overrides `REMOTE_HOST` and deploys to the wrong box.

`stockademade.conf` additionally sets
`APACHE_SERVER_ALIASES="www.stockademade.com"`.

### `deploy/sites/<site>.env`

Per-site non-secret runtime config. `SITE_ROOT` and `PUBLIC_BASE_URL`
differ per site; `OLLAMA_BASE_URL`, `SPAM_*`, and `SMTP_PORT` are the
same values repeated. Repetition is deliberate — merging a shared env
file into a per-site one adds a precedence rule to debug for three
lines of savings.

### `deploy/secrets/<site>.secrets.env`

Per-site `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (one OAuth client
per host, so a leak on one site can't authenticate against another),
`ADMIN_TOKEN`, `OLLAMA_TOKEN`, and SMTP credentials.

`.gitignore` currently lists `secrets.env` by exact name. Add
`deploy/secrets/` so the new files can never be committed.

## Changes to existing files

**1. `deploy/hooks/fastify_app.build.post.sh`** — replace the hardcoded
`config_env="$PROJECT_DIR/deploy/config.env"` with
`config_env="$PROJECT_DIR/${SITE_ENV_FILE:?SITE_ENV_FILE not set}"`.
Everything else in the hook is site-independent.

**2. `deploy/hooks/apache.build.post.sh`** — emit `ServerAlias` in both
the `:80` and `:443` blocks when `APACHE_SERVER_ALIASES` is set, and add
a redirect from each alias to `DOMAIN_NAME` in the `:443` block so the
canonical host is unambiguous. `letsencrypt/start.sh:18` already reads
the same variable to add SAN entries, so the cert and the vhost stay in
agreement from one setting.

**3. Same hook, new guard** — fail the build unless
`SITE_ROOT` equals `${FASTIFY_APP_DATA_PATH}/${APP_NAME}`. A mismatch
points the app at a directory the systemd unit doesn't own; the failure
mode is a service that starts and then can't write, which is slow to
diagnose. Cheap to assert at build time.

**4. `deploy/secrets.env.example`** — update the header comment: the
file is copied per site into `deploy/secrets/<site>.secrets.env`, and
the redirect URI is `https://<site-domain>/auth/google/callback`.

## Rollout

Per site, in order, and only after the previous one is verified:

1. Create the Google OAuth client for the host; authorized redirect URI
   `https://<domain>/auth/google/callback`.
2. Fill `deploy/secrets/<site>.secrets.env` from the example; generate
   `ADMIN_TOKEN` with `openssl rand -hex 32`.
3. Point DNS at the VPS. Certbot's webroot challenge needs the name
   resolving before `init` runs.
4. `DEPLOY_SH_CONF=deploy/sites/<site>.conf ~/src/deploy.sh/deploy.sh init .`
5. Verify: unit active, `https://<domain>/` returns 200, OAuth sign-in
   reaches the admin, and the other sites are still up.

Subsequent deploys use `update` in place of `init`. Ordering matters
only in that each `init` obtains a certificate and reloads Apache; a
broken vhost would take the other sites down with it.

The demo site needs no re-`init` — its `APP_NAME`, port, paths, and
`/etc/rkr-blog.env` are unchanged by this refactor. Its next `update`
picks up the new config path through the shim.

## Testing

The deploy path has no automated coverage and this spec doesn't add
any — the modules are shell run against a real host. Verification is
the rollout checklist above, plus two checks that catch the errors this
design is most likely to produce:

- Deploy the demo site first with no other changes, confirming the
  config move is a no-op. This isolates the refactor from the new sites.
- After the second site is up, confirm `/etc/roll-along.env` and
  `/etc/rkr-blog.env` have different `SITE_ROOT`, `PUBLIC_BASE_URL`,
  `ADMIN_TOKEN`, and `GOOGLE_CLIENT_ID` values, and that each unit's
  `ExecStart` names its own app directory. Cross-contamination between
  sites is the failure this layout exists to prevent, so it gets an
  explicit check rather than being assumed.

## Out of scope

- **Legacy WordPress permalinks.** Both sites used
  `/%year%/%monthnum%/%day%/%postname%/`; rkr-blog serves `/:slug`.
  Import preserves slugs, so the only breakage is ~47 in-content links
  (29 roll-along, 18 stockademade). Separate decision, tracked in
  `docs/DEFERRED.md`.
- **Content import.** Covered by `docs/RUNBOOK.md`.
- **Shared-nothing hardening.** Three services run as the same
  `www-data` user, so this is separation of configuration, not a
  security boundary. Adequate for three sites with one owner; revisit
  if a site gains an author who shouldn't reach the others.

## Docs to update in the implementing commit

- `docs/RUNBOOK.md` — deploying a specific site; the `DEPLOY_SH_CONF`
  form and the per-site table.
- `docs/DEFERRED.md` — add the legacy-permalink item.
