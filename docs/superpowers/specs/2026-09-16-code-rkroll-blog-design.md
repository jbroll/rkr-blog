# Design: third blog site (`code.rkroll.com`) with token login

**Date:** 2026-09-16
**Scope:** Add a third `rkr-blog` site instance at `code.rkroll.com`, using token-based admin login, deployed to the existing VPS (`rkr-blog.rkroll.com`).

## Goal

Create and deploy a new blog instance (`code.rkroll.com`) from the same codebase, distinct data directory, and token-only authentication. No new application code is required.

## Context

The repository already supports multiple independent sites via environment variables. Two sites are deployed:

| Site | Domain | `APP_NAME` | Port | Auth |
|---|---|---|---|---|
| roll-along | `roll-along.rkroll.com` (admin on `rkr-blog.rkroll.com`) | `rkr-blog` | 3000 | Google OAuth |
| stockademade | `stockademade.com` (`www.` 301s to apex) | `stockademade` | 3004 | Token-only |

Token login is already fully implemented:
- `ADMIN_TOKEN` env var enables `/login` form + `POST /admin/auth/token-login`.
- `Authorization: Bearer <ADMIN_TOKEN>` works for CLI/tools.
- Leaving `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` unset makes Google routes 404 and hides the Google button on `/login`.
- Title, tagline, and theme are editable online at `/admin/settings` and persist to `config/site.json` in `SITE_ROOT`.

## Design

### 1. Deploy identity

Create `deploy/sites/code.conf` modeled on `stockademade.conf`:

```bash
source "$(dirname "${BASH_SOURCE[0]}")/../common.conf"

export APP_NAME="code"
export DOMAIN_NAME="code.rkroll.com"
export REMOTE_HOST="rkr-blog.rkroll.com"
export FASTIFY_APP_PORT="3005"   # verify against /var/lib/deploy.sh/ports on VPS

export SITE_ENV_FILE="deploy/sites/code.env"
export FASTIFY_APP_SECRETS_FILE="deploy/secrets/code.secrets.env"

export APACHE_PROXY_RULES="/:${FASTIFY_APP_PORT}:/"
```

No `APACHE_SERVER_ALIASES`, `APACHE_ADMIN_HOST`, `ADMIN_BASE_URL`, or `DEPLOY_IMAGE_EDITOR`.

### 2. Runtime environment

Create `deploy/sites/code.env` with `rkr-blog` feature parity, single host:

```bash
SITE_ROOT=/var/www/code
PUBLIC_BASE_URL=https://code.rkroll.com

OLLAMA_BASE_URL=https://symon.rkroll.com:554/ollama
SPAM_MODEL=llama3.2:3b
SPAM_TIMEOUT_MS=8000
SPAM_MAX_ATTEMPTS=3

SMTP_PORT=587
```

### 3. Secrets

Create `deploy/secrets/code.secrets.env` (gitignored) from `deploy/secrets.env.example`:

```bash
ADMIN_TOKEN=<from pass services/code.rkroll.com/admin-token>
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=
# OLLAMA_TOKEN=
# SMTP_HOST=
# SMTP_USER=
# SMTP_PASS=
# NOTIFY_TO=
```

The `ADMIN_TOKEN` was generated with `openssl rand -hex 32` and stored in `pass` at `services/code.rkroll.com/admin-token`.

### 4. Tests

Update `test/deploy/site-config.test.ts`:
- Add `'code'` to the `SITES` array.
- Add a `code` identity test asserting `APP_NAME`, `DOMAIN_NAME`, `FASTIFY_APP_PORT`, `SITE_ENV_FILE`, and `FASTIFY_APP_SECRETS_FILE`.

This enforces distinct ports, app names, env files, secrets files, and domains across all sites.

### 5. Documentation

Update `docs/RUNBOOK.md`:
- Add `code` row to the site table.
- Update prose that says "Two sites are configured" to "Three sites are configured".

Optionally generalize the token-only note in `docs/DEFERRED.md` to mention `code.rkroll.com` alongside `stockademade`.

### 6. Deploy procedure

1. Ensure DNS `code.rkroll.com` A record points to the VPS.
2. Verify `FASTIFY_APP_PORT=3005` is free in `/var/lib/deploy.sh/ports` on the VPS; adjust if taken.
3. Run:
   ```bash
   DEPLOY_SH_CONF=deploy/sites/code.conf ~/src/deploy.sh/deploy.sh init .
   ```
   Do not pass a `user@host` argument; it overrides `REMOTE_HOST`.
4. Post-deploy verification:
   - Cross-site secret uniqueness check:
     ```bash
     sudo grep -hE '^(SITE_ROOT|PUBLIC_BASE_URL|ADMIN_TOKEN|GOOGLE_CLIENT_ID)=' \
       /etc/rkr-blog.env /etc/stockademade.env /etc/code.env | sort | uniq -d
     ```
     Must produce no output.
   - Confirm `roll-along.rkroll.com` and `stockademade.com` still respond after Apache reload.

## Trade-offs considered

- **Minimal token-only (clone of stockademade):** smaller change, but would not mirror `rkr-blog`'s Ollama/SMTP features. Rejected.
- **Two-host token login:** possible, but unnecessary because token login has no OAuth host-cookie constraints. Rejected per user choice.
- **Single-host token-only with `rkr-blog` feature parity:** matches the "mirror `rkr-blog`" intent while keeping the simpler single-host deploy. Selected.

## Out of scope

- New application features (auth, admin UI, theming already support the requirement).
- Image editor PWA for `code.rkroll.com` (can be enabled later with `DEPLOY_IMAGE_EDITOR=yes`).
- Custom site title/tagline/theme at deploy time (editable later at `/admin/settings`).
- DNS changes (assumed done by operator before `init`).

## Risks

- Port `3005` may already be claimed on the VPS; must be verified before deploy.
- A malformed vhost config from `init` would take down all Apache-hosted sites on the VPS.
- Missing `deploy/secrets/code.secrets.env` causes deploy to fail by design.
