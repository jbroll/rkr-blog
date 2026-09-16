# Dossier: third blog site instance with token login on code.rkroll.com

- **Date:** 2026-09-16
- **Task:** Add a third rkr-blog site instance, admin login via ADMIN_TOKEN (no Google OAuth), deployed to code.rkroll.com
- **Classification:** deployment/config (feature surface = zero new app code; token auth already exists)
- **Scope:** small-medium (3 new deploy files + 1 test file edit + 2 doc files; no `src/` changes expected)

---

## 1. Repo structure and project type

Single-author, photo-first blog CMS. **Node 22 + TypeScript (type-stripped, no build step for server code), Fastify 5, SQLite (`node:sqlite`), Apache reverse proxy on a VPS.** ES modules (`"type": "module"`), npm workspaces (`packages/*`, `apps/*`).

- `src/` — server + browser code. `src/server.ts` = `buildApp()` factory + `startServer()`; `src/routes/` = Fastify route plugins; `src/lib/` = shared logic; `src/cli/` = `site-admin` subcommands.
- `bin/server.js`, `bin/site-admin` — entry points (run via `node --experimental-strip-types`).
- `packages/image-edit` — shared image pipeline (built with esbuild); `apps/image-pwa` — standalone editor PWA, deployed only where `DEPLOY_IMAGE_EDITOR=yes` (rkr-blog only).
- `static/admin`, `static/site` — esbuild bundle outputs (built at deploy time, not committed).
- `test/` — `node:test` unit tests mirroring `src/` layout + `test/e2e/` Playwright specs + `test/deploy/` deploy-hook/site-config tests.
- `deploy/` — per-site deploy.sh configs (see §5).
- `website/` — separate static marketing site, deployed independently to `rkr-blog-www.rkroll.com`.
- `docs/` — spec, implementation, quickstart, RUNBOOK, DEFERRED, backlog, theming.

**One codebase serves multiple independent sites.** Site identity comes entirely from env: `SITE_ROOT` (data dir), `PUBLIC_BASE_URL`, `ADMIN_BASE_URL`, `PORT`, `ADMIN_TOKEN`, optional `GOOGLE_CLIENT_ID/SECRET`. Two sites are already deployed (rkr-blog @ roll-along.rkroll.com, stockademade @ stockademade.com). A third site is a deploy-config addition, not an app change.

## 2. Key finding: token-based login already exists end-to-end

No new auth code is needed. The app ships three login mechanisms, and token login is complete and tested:

| Mechanism | Where | Used by |
|---|---|---|
| Google OAuth (cookie session) | `src/routes/auth.ts` (`/admin/auth/google/start`, `/admin/auth/google/callback`) | rkr-blog site |
| **Browser token login** | `src/routes/auth.ts` → `GET /login` (form), `POST /admin/auth/token-login` → mints normal session cookie | **the mechanism this task uses** |
| **Bearer header (stateless CLI)** | `src/lib/auth-middleware.ts` — `Authorization: Bearer <ADMIN_TOKEN>` → synthetic owner user (id=0) | `site-admin reset/import-wp` etc. |

Token login specifics to rely on:
- `process.env.ADMIN_TOKEN` is the only secret. Unset ⇒ `/login` shows "Token login disabled" and bearer path rejects. Set ⇒ both work.
- **Token-only site works out of the box with `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` left unset.** `auth.ts` deliberately boots without them (the google routes 404, the login page hides the Google link). Verified by `test/routes/auth-no-google.test.ts`. This is exactly the stockademade pattern (`docs/DEFERRED.md` line 66).
- Token comparison is `timingSafeEqual` (`src/lib/admin-token.ts`); wrong-token attempts are per-IP throttled (`src/lib/login-throttle.ts`, default 5 per 5 min, correct token never throttled).
- No Google client ⇒ no OAuth `redirect_uri` host constraints ⇒ **no need to split admin/public hostnames**; `ADMIN_BASE_URL` can be omitted (defaults to `PUBLIC_BASE_URL`).
- The `/login` page + `?_rkr=login` bust param interact with the public service worker; that's all in-place and covered by `test/e2e/login.spec.ts`.

## 3. Files to touch

| Path | Change | Why |
|---|---|---|
| `deploy/sites/code.conf` | **new** | Per-site deploy identity (mirror `stockademade.conf`): `APP_NAME=code`, `DOMAIN_NAME=code.rkroll.com`, `REMOTE_HOST=rkr-blog.rkroll.com`, `FASTIFY_APP_PORT=<unused>`, `SITE_ENV_FILE=deploy/sites/code.env`, `FASTIFY_APP_SECRETS_FILE=deploy/secrets/code.secrets.env`, `APACHE_PROXY_RULES="/:<port>:/"`. No `APACHE_SERVER_ALIASES`, no `APACHE_ADMIN_HOST`, no `DEPLOY_IMAGE_EDITOR` (defaults off). |
| `deploy/sites/code.env` | **new** | Non-secret runtime env (git-tracked): `SITE_ROOT=/var/www/code`, `PUBLIC_BASE_URL=https://code.rkroll.com`, and (copy from stockademade.env) `OLLAMA_BASE_URL`, `SPAM_MODEL`, `SPAM_TIMEOUT_MS`, `SPAM_MAX_ATTEMPTS`, `SMTP_PORT`. No `ADMIN_BASE_URL` needed (single host). |
| `deploy/secrets/code.secrets.env` | **new** (gitignored) | Copy of `deploy/secrets.env.example`, fill only `ADMIN_TOKEN` (`openssl rand -hex 32`). **Leave GOOGLE_CLIENT_* empty** for a token-only site. OLLAMA_TOKEN/SMTP/`NOTIFY_TO` optional. |
| `test/deploy/site-config.test.ts` | edit | `const SITES = ['rkr-blog', 'stockademade']` → add `'code'` (line 105). This test then enforces: distinct port/app-name/env-file/secrets-file/domain per site, no hostname claimed by two vhosts, and `SITE_ROOT == /var/www/<APP_NAME>`. Optionally add a `code site config` identity test mirroring the stockademade one (lines 92–98). |
| `docs/RUNBOOK.md` | edit | Add `code` row to the site table (lines 11–14) with port; update "First deploy of a new site" references. |
| `docs/DEFERRED.md` | optional | The "no Google OAuth client" note (line 66) pattern now covers code as well; leave or generalize. |

**Do NOT touch** unless deploy reveals a problem: `deploy/hooks/*` (shared), `deploy/common.conf` (shared), `src/routes/auth.ts`, `src/lib/auth-middleware.ts`, `src/lib/admin-token.ts`, `bin/*`.

## 4. Deployment procedure (from `docs/RUNBOOK.md` §"First deploy of a new site")

1. DNS: point `code.rkroll.com` (A record) at the VPS before `init` (certbot webroot challenge needs resolution). `REMOTE_HOST` stays `rkr-blog.rkroll.com` — that's the VPS hostname, not the site domain.
2. Pick an unused `FASTIFY_APP_PORT`. Registry on the VPS: `/var/lib/deploy.sh/ports`. Used: 3000 (rkr-blog), 3004 (stockademade). Do not claim a taken port.
3. Create `deploy/secrets/code.secrets.env` (mandatory — `fastify_app.build.post.sh` **fails the deploy** if the secrets file is missing).
4. `DEPLOY_SH_CONF=deploy/sites/code.conf ~/src/deploy.sh/deploy.sh init .` then `update .` for later deploys. **Never pass a `user@host` argument** — it overrides `REMOTE_HOST` and deploys to the wrong machine.
5. Deploy artifacts are named by `APP_NAME=code`: unit `code.service` (with `ExecStartPre` `site-admin init`), app `/opt/code`, data `/var/www/code`, merged env `/etc/code.env`. `SITE_ROOT` in `code.env` must equal `/var/www/code` — both build hooks hard-fail on mismatch.
6. Post-deploy check: `sudo grep -hE '^(SITE_ROOT|PUBLIC_BASE_URL|ADMIN_TOKEN|GOOGLE_CLIENT_ID)=' /etc/rkr-blog.env /etc/stockademade.env /etc/code.env | sort | uniq -d` must be empty (no shared values across sites).
7. `init` reloads Apache — verify the other two sites still respond after deploying.

## 5. Existing deployment config

- **`deploy.conf`** — root shim, sources `deploy/sites/rkr-blog.conf` (default target = roll-along).
- **`deploy/common.conf`** — shared: `DEPLOY_TYPES="letsencrypt apache fastify_app"`, `REMOTE_USER=john`, Let's Encrypt email `john@rkroll.com`, `APACHE_MODE=proxy`, `FASTIFY_APP_USER/GROUP=www-data`, base path `/opt`, data path `/var/www`, `FASTIFY_APP_MAIN_SCRIPT=bin/server.js`, `FASTIFY_APP_NODE_OPTIONS="--no-warnings=ExperimentalWarning --experimental-strip-types"`.
- **`deploy/sites/rkr-blog.conf`** — two-hostname split (`DOMAIN_NAME=roll-along.rkroll.com`, `APACHE_SERVER_ALIASES=rkr-blog.rkroll.com`, `APACHE_CANONICAL_REDIRECT=no`, `APACHE_ADMIN_HOST=rkr-blog.rkroll.com`), port 3000, `DEPLOY_IMAGE_EDITOR=yes`.
- **`deploy/sites/stockademade.conf`** — the model for a plain single-host site: `DOMAIN_NAME=stockademade.com`, `APACHE_SERVER_ALIASES=www.stockademade.com` (301 to apex), port 3004, no admin-host pinning, no image editor.
- **`deploy/hooks/apache.build.post.sh`** — writes the vhost: canonical-alias 301s, optional `/admin`+`/login` 308 pin to `APACHE_ADMIN_HOST`, `/img/` disk fast-path rewrite, immutable cache headers on `/cache/`+`/static/`, optional `/image-editor` alias. Requires `SITE_ENV_FILE` and `SITE_ROOT` consistency.
- **`deploy/hooks/fastify_app.build.post.sh`** — writes git-hash, merges `SITE_ENV_FILE` into secrets.env (secrets win), **fails on missing secrets file**, fails if `SITE_ROOT` mismatches, fails if `PUBLIC_BASE_URL`/`ADMIN_BASE_URL` appear in the secrets file, strips `workspaces` from shipped package.json, optional image-PWA build.
- **`deploy/hooks/fastify_app.configure.post.sh`** — adds `ExecStartPre=node bin/site-admin init` to the systemd unit.
- **`deploy/hooks/letsencrypt.start.pre.sh`** — ensures ACME webroot exists.
- **`deploy/secrets.env.example`** — the template for each site's secrets file.
- All rkroll.com sites live on **one VPS** (`rkr-blog.rkroll.com` resolves there). Apache fronts every site; each site is its own systemd unit + port + `/etc/<app>.env`.

## 6. Key types/interfaces

- `buildApp(opts: BuildAppOpts): Promise<FastifyInstance>` (`src/server.ts`) — `auth` opt group: `{ exchange?, verifier?, secureCookies?, skipGate?, allowedOrigins?, publicOnlyOrigins?, tokenLoginRateMax? }`. Production `startServer()` derives `allowedOrigins` from `PUBLIC_BASE_URL`/`ADMIN_BASE_URL` via `csrfAllowedOrigins()`. If `PUBLIC_BASE_URL` is unset, `startServer()` **throws** — `code.env` must set it.
- `siteConfig / paths / siteRoot / publicBaseUrl / adminBaseUrl / serverConfig` (`src/lib/config.ts`) — all env-driven. `paths()` derives everything from `SITE_ROOT`.
- `AuthRoutesOpts` (`src/routes/auth.ts`) — `{ db, exchange?, verifier?, postLoginPath?, secureCookies?, tokenLoginRateMax? }`.
- `User` (`src/lib/users.ts`) — `{ id, email, display_name, role: 'owner'|'editor', created_at, last_seen_at }`; `findOrCreateTokenAdmin(db)` creates the synthetic admin for token login.
- `parseBearerToken(auth?: string): string | undefined` (`src/lib/bearer.ts`); `adminTokenMatchesEnv(provided: string): boolean` (`src/lib/admin-token.ts`).
- Deploy-side contract (test-enforced): each site config must export `APP_NAME`, `DOMAIN_NAME`, `REMOTE_HOST`, `FASTIFY_APP_PORT`, `SITE_ENV_FILE`, `FASTIFY_APP_SECRETS_FILE`; all five identity values unique across sites.

## 7. Environment variables (app reads at runtime)

- **Required:** `SITE_ROOT`, `PUBLIC_BASE_URL` (server refuses to boot without it).
- **Auth:** `ADMIN_TOKEN` (required for token login; without it the site still boots but nobody can log in), `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (optional — leave unset for token-only).
- **Optional:** `ADMIN_BASE_URL`, `PORT` (default 3000; deploy sets from `FASTIFY_APP_PORT`), `HOST` (default 127.0.0.1), `LOG_LEVEL`, `SITE_TITLE`, `SITE_TAGLINE`, `SITE_THEME`, `NOTIFY_TO`, `SMTP_*`, `OLLAMA_BASE_URL`, `OLLAMA_TOKEN`, `SPAM_MODEL`, `SPAM_TIMEOUT_MS`, `SPAM_MAX_ATTEMPTS`, `ENABLE_TEST_ROUTES`, `MICROSOFT_CLIENT_ID/SECRET/TENANT` (OneDrive picker).
- Merge order on deploy: `code.env` (non-secrets, git) then `code.secrets.env` (gitignored) into `/etc/code.env`; **secrets win**.

## 8. Test setup

Relevant commands:
- `npm test` — all unit tests (`node --test test/**/*.test.ts`).
- **`node --test test/deploy/site-config.test.ts`** — the test that must be extended (SITES array); run it before/after the change. Also run the full deploy group: `node --test test/deploy/` (also covers `apache-hook.test.ts`, `fastify-app-hook.test.ts`).
- `npm run test:coverage` — c8 with per-file thresholds (lines=90 / branches=75 / fns=90); the gate runs this.
- `npm run test:e2e` — Playwright; `test/e2e/login.spec.ts` covers the token-login browser flow (admin token `e2e-test-token-do-not-use-in-prod`).
- `npm run typecheck` / `npm run lint` / `npm run check` — tsc + biome + coverage. Pre-commit gate via lefthook runs all of these plus knip, circular-import, size caps (500 lines/file in `src/`,`bin/`; tests exempt).

Tests that pin the auth behavior (useful as regression context, no changes expected): `test/routes/auth-no-google.test.ts` (token-only site boots, google routes 404), `test/lib/bearer-auth.test.ts`, `test/lib/login-throttle.test.ts`, `test/e2e/login.spec.ts`.

## 9. Conventions

- **Deploy site configs:** one `.conf` (exports, sources `common.conf`) + one git-tracked `.env` (non-secrets) + one gitignored `.secrets.env` per site. Header comment block in each file explaining the site and the exact deploy command. Bash vars UPPER_SNAKE, sourced with `export`.
- **`SITE_ROOT` invariant:** must equal `/var/www/<APP_NAME>`; both build hooks and `site-config.test.ts` enforce it.
- **Never put `PUBLIC_BASE_URL`/`ADMIN_BASE_URL` in a secrets file** (silently wins the merge; hook rejects it).
- Code style (`docs/developer-quickstart.md §4`): ES modules, `.ts` import extensions server-side, kebab-case filenames, named exports (default only for CLI entries + route plugins), no top-level side effects, no global state, 2-space indent, Biome (no ESLint/Prettier).
- **Docs change in the same commit as the code** — RUNBOOK site table + DEFERRED note update alongside the configs.
- Deferred work goes in `docs/DEFERRED.md`, not comments. Backlog is `docs/backlog.md`.
- Deploy runs from the working tree via deploy.sh (`~/src/deploy.sh/deploy.sh`); CI/e2e also test the working tree, not a commit.

## 10. Dependencies / tooling used by this task

- `~/src/deploy.sh/deploy.sh` — external deploy runner (not in this repo); DEPLOY_TYPES `letsencrypt apache fastify_app` handled by its stock modules + this repo's hooks.
- Apache + certbot on the VPS (system packages, not repo deps).
- App-level deps relevant to auth (already installed): `@fastify/cookie`, `arctic`, `jose`, `@fastify/rate-limit`, `@fastify/multipart`, `@fastify/static`.
- No new npm packages expected for this task.

## 11. Risks / gotchas

- Forgetting the secrets file ⇒ deploy fails (by design).
- Port conflict on the VPS (`/var/lib/deploy.sh/ports` registry) ⇒ cert + Apache reload happen *before* the refusal; pick the port first.
- A new site's `init` reloads Apache — a broken vhost takes all sites down.
- `code.rkroll.com` DNS must resolve before `init` (cert issuance).
- ADMIN_TOKEN generation: `openssl rand -hex 32`; it is a single static token (no rotation UI) — keep it in the gitignored secrets file only.

---

## Summary

The app already implements everything "token-based login" needs: `ADMIN_TOKEN` env var, a `/login` page + `POST /admin/auth/token-login` that mints a normal session cookie, a bearer-header path for scripted clients, timing-safe comparison, per-IP brute-force throttling, and a documented token-only deployment mode (no Google client ⇒ Google routes 404, login page shows only the token form — stockademade already runs this way). The third site is therefore a **deploy-config task**: three new files under `deploy/` (`code.conf`, `code.env`, `code.secrets.env` with `APP_NAME=code`, `DOMAIN_NAME=code.rkroll.com`, an unused port), one test-file edit (`test/deploy/site-config.test.ts` SITES array), and RUNBOOK/DEFERRED doc updates. No `src/` changes are expected. Deploy via `DEPLOY_SH_CONF=deploy/sites/code.conf ~/src/deploy.sh/deploy.sh init .` after DNS + secrets + port are in place; verify with the cross-site `grep uniq -d` check and by confirming the two existing sites survive the Apache reload.

**Caveat:** The dossier subagent could not write this file — its toolset had no write/apply_patch tool, so the content was delivered in the task result and persisted here by the caller.
