# code.rkroll.com blog site implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third `rkr-blog` site instance at `code.rkroll.com` with token-only admin login, deployed to the existing VPS.

**Architecture:** One codebase serves multiple independent sites via environment variables. The third site needs only deploy configuration: a `.conf` file for deploy.sh identity, a `.env` file for non-secret runtime config, a `.secrets.env` file for the admin token, plus test and runbook updates. No application code changes.

**Tech Stack:** Bash (deploy.sh config), TypeScript (`node:test` deploy tests), `pass` (secret storage).

## Global Constraints

- `APP_NAME` must equal the last path component of `SITE_ROOT` (`/var/www/<APP_NAME>`).
- Each site must have a distinct `FASTIFY_APP_PORT`, `APP_NAME`, `DOMAIN_NAME`, `SITE_ENV_FILE`, and `FASTIFY_APP_SECRETS_FILE`.
- `PUBLIC_BASE_URL` must match `https://<DOMAIN_NAME>`.
- `ADMIN_BASE_URL` and `APACHE_ADMIN_HOST` are omitted for single-host token-only sites.
- Secrets live in `deploy/secrets/<site>.secrets.env` (gitignored); non-secrets in `deploy/sites/<site>.env` (committed).
- `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are left empty for token-only deployment.
- Title, tagline, and theme are editable later at `/admin/settings` and persist to `config/site.json`.

---

## File structure

| File | Purpose |
|---|---|
| `deploy/sites/code.conf` | Deploy.sh site identity: app name, domain, port, env/secrets paths, proxy rules. |
| `deploy/sites/code.env` | Non-secret runtime env: `SITE_ROOT`, `PUBLIC_BASE_URL`, Ollama/SMTP settings. |
| `deploy/secrets/code.secrets.env` | Gitignored secrets: `ADMIN_TOKEN` from pass. |
| `test/deploy/site-config.test.ts` | Add `code` to the multi-site integrity tests. |
| `docs/RUNBOOK.md` | Add `code` to the site table and update site count prose. |

---

### Task 1: Create deploy site config (`deploy/sites/code.conf`)

**Files:**
- Create: `deploy/sites/code.conf`

**Interfaces:**
- Consumes: `deploy/common.conf` (shared deploy settings).
- Produces: `APP_NAME=code`, `DOMAIN_NAME=code.rkroll.com`, `FASTIFY_APP_PORT=3005` (verify on VPS before deploy).

- [ ] **Step 1: Write the config file**

```bash
# code.rkroll.com — token-only rkr-blog instance.
#
# Single-host deploy: readers and admin UI share code.rkroll.com.
# Token login is enabled by setting ADMIN_TOKEN in the secrets file.
#
# Usage:
#   DEPLOY_SH_CONF=deploy/sites/code.conf ~/src/deploy.sh/deploy.sh init .
#
# REMOTE_HOST is the VPS, not this site's public domain. Do NOT pass a
# user@host argument — it overrides REMOTE_HOST.

source "$(dirname "${BASH_SOURCE[0]}")/../common.conf"

export APP_NAME="code"
export DOMAIN_NAME="code.rkroll.com"
export REMOTE_HOST="rkr-blog.rkroll.com"
export FASTIFY_APP_PORT="3005"

export SITE_ENV_FILE="deploy/sites/code.env"
export FASTIFY_APP_SECRETS_FILE="deploy/secrets/code.secrets.env"

export APACHE_PROXY_RULES="/:${FASTIFY_APP_PORT}:/"
```

- [ ] **Step 2: Verify the config loads without errors**

Run:
```bash
bash -c 'set -a; source deploy/sites/code.conf; set +a; echo APP_NAME=$APP_NAME; echo DOMAIN_NAME=$DOMAIN_NAME; echo PORT=$FASTIFY_APP_PORT'
```

Expected:
```
APP_NAME=code
DOMAIN_NAME=code.rkroll.com
PORT=3005
```

---

### Task 2: Create non-secret runtime env (`deploy/sites/code.env`)

**Files:**
- Create: `deploy/sites/code.env`

**Interfaces:**
- Consumes: `OLLAMA_BASE_URL` and SMTP services already available to other sites.
- Produces: Non-secret env merged into `/etc/code.env` on deploy.

- [ ] **Step 1: Write the env file**

```bash
# Non-secret runtime configuration for code.rkroll.com.
# Committed to git — do not put secrets here.
# Secrets live in deploy/secrets/code.secrets.env (gitignored). Both
# files are merged into /etc/code.env on deploy; secrets win on any
# collision.

SITE_ROOT=/var/www/code
PUBLIC_BASE_URL=https://code.rkroll.com

OLLAMA_BASE_URL=https://symon.rkroll.com:554/ollama
SPAM_MODEL=llama3.2:3b
SPAM_TIMEOUT_MS=8000
SPAM_MAX_ATTEMPTS=3

SMTP_PORT=587
```

- [ ] **Step 2: Verify hook-parseable values**

Run:
```bash
grep -E '^SITE_ROOT=|^PUBLIC_BASE_URL=' deploy/sites/code.env
```

Expected:
```
SITE_ROOT=/var/www/code
PUBLIC_BASE_URL=https://code.rkroll.com
```

---

### Task 3: Create secrets file (`deploy/secrets/code.secrets.env`)

**Files:**
- Create: `deploy/secrets/code.secrets.env`

**Interfaces:**
- Consumes: `ADMIN_TOKEN` from `pass services/code.rkroll.com/admin-token`.
- Produces: Gitignored secrets file used by deploy and local tests.

- [ ] **Step 1: Read the token from pass**

Run:
```bash
pass show services/code.rkroll.com/admin-token
```

Expected: a 64-character hex string.

- [ ] **Step 2: Write the secrets file**

Create `deploy/secrets/code.secrets.env`:

```bash
# Secrets for code.rkroll.com.
# deploy/secrets/ is gitignored. Never commit this file.

# Google OAuth is disabled for this token-only site.
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Admin login token. Generate with: openssl rand -hex 32
ADMIN_TOKEN=<paste token from pass>

# Token for the Ollama proxy (optional).
OLLAMA_TOKEN=

# SMTP credentials for comment email notifications (optional).
SMTP_HOST=
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
NOTIFY_TO=
```

- [ ] **Step 3: Verify the file exists and is gitignored**

Run:
```bash
git check-ignore deploy/secrets/code.secrets.env && echo 'ignored'
```

Expected:
```
ignored
```

---

### Task 4: Update deploy site-config tests

**Files:**
- Modify: `test/deploy/site-config.test.ts`

**Interfaces:**
- Consumes: `deploy/sites/code.conf` and `deploy/sites/code.env` from previous tasks.
- Produces: Updated test assertions that include `code` in multi-site integrity checks.

- [ ] **Step 1: Add a `code` identity test after the stockademade test**

Insert after lines 92–98:

```typescript
test('code site config uses the site domain with no aliases', () => {
  const c = loadConfig('deploy/sites/code.conf');
  assert.equal(c.APP_NAME, 'code');
  assert.equal(c.DOMAIN_NAME, 'code.rkroll.com');
  assert.equal(c.FASTIFY_APP_PORT, '3005');
  assert.equal(c.SITE_ENV_FILE, 'deploy/sites/code.env');
  assert.equal(c.FASTIFY_APP_SECRETS_FILE, 'deploy/secrets/code.secrets.env');
  assert.equal(c.APACHE_SERVER_ALIASES, undefined);
  assert.equal(c.APACHE_ADMIN_HOST, undefined);
});

test('code PUBLIC_BASE_URL matches the canonical domain', () => {
  const c = loadConfig('deploy/sites/code.conf');
  const publicBase = readEnvKeyAsHookWould('deploy/sites/code.env', 'PUBLIC_BASE_URL');
  assert.equal(publicBase, `https://${c.DOMAIN_NAME}`);
});
```

- [ ] **Step 2: Add `code` to the SITES array**

Change:
```typescript
const SITES = ['rkr-blog', 'stockademade'];
```

To:
```typescript
const SITES = ['rkr-blog', 'stockademade', 'code'];
```

- [ ] **Step 3: Run the deploy site-config tests**

Run:
```bash
node --test test/deploy/site-config.test.ts
```

Expected: all tests pass.

---

### Task 5: Update operator runbook

**Files:**
- Modify: `docs/RUNBOOK.md`

**Interfaces:**
- Consumes: `FASTIFY_APP_PORT=3005` and `APP_NAME=code` from the deploy config.
- Produces: Accurate operator documentation.

- [ ] **Step 1: Update the site-count prose**

Change line 8:
```markdown
Two sites are configured in this tree, each as its own systemd service.
Both are deployed.
```

To:
```markdown
Three sites are configured in this tree, each as its own systemd service.
All are deployed.
```

- [ ] **Step 2: Add the `code` row to the site table**

Change the table:
```markdown
| Site | Domain | `APP_NAME` | Port | Deployed |
|---|---|---|---|---|
| roll-along | roll-along.rkroll.com, admin on rkr-blog.rkroll.com | `rkr-blog` | 3000 | yes |
| stockademade | stockademade.com (`www.` 301s to apex) | `stockademade` | 3004 | yes |
```

To:
```markdown
| Site | Domain | `APP_NAME` | Port | Deployed |
|---|---|---|---|---|
| roll-along | roll-along.rkroll.com, admin on rkr-blog.rkroll.com | `rkr-blog` | 3000 | yes |
| stockademade | stockademade.com (`www.` 301s to apex) | `stockademade` | 3004 | yes |
| code | code.rkroll.com | `code` | 3005 | yes |
```

- [ ] **Step 3: Render the table to verify Markdown syntax**

Run:
```bash
head -20 docs/RUNBOOK.md
```

Expected: table renders with three data rows.

---

### Task 6: Run full deploy test suite

**Files:**
- None (verification only).

**Interfaces:**
- Consumes: all files created/modified above.

- [ ] **Step 1: Run all deploy tests**

Run:
```bash
node --test test/deploy/
```

Expected: all tests pass.

- [ ] **Step 2: Run lint/typecheck on changed files**

Run:
```bash
npm run lint
npm run typecheck
```

Expected: no errors.

---

### Task 7: Commit the changes

**Files:**
- All created/modified files above.

- [ ] **Step 1: Stage and inspect**

Run:
```bash
git status
```

Expected new files:
- `deploy/sites/code.conf`
- `deploy/sites/code.env`
- `docs/superpowers/specs/2026-09-16-code-rkroll-blog-design.md`
- `docs/superpowers/plans/2026-09-16-code-rkroll-blog-plan.md`
- `docs/superpowers/dossiers/third-blog-token-login-dossier.md`

Expected modified files:
- `test/deploy/site-config.test.ts`
- `docs/RUNBOOK.md`

`deploy/secrets/code.secrets.env` should be untracked (gitignored).

- [ ] **Step 2: Commit**

Run:
```bash
git add deploy/sites/code.conf deploy/sites/code.env test/deploy/site-config.test.ts docs/RUNBOOK.md docs/superpowers/specs/2026-09-16-code-rkroll-blog-design.md docs/superpowers/plans/2026-09-16-code-rkroll-blog-plan.md docs/superpowers/dossiers/third-blog-token-login-dossier.md
git commit -m "deploy: add code.rkroll.com token-only site"
```

Expected: commit succeeds.

---

## Self-review

**Spec coverage:**
- Token-only login → `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` left empty in secrets file.
- Single host → no `ADMIN_BASE_URL`, `APACHE_ADMIN_HOST`, or `APACHE_SERVER_ALIASES`.
- `rkr-blog` feature parity → Ollama/SMTP settings copied from `rkr-blog.env`.
- Distinct site identity → `code` added to `SITES` array and identity test.
- Runbook updated → site table and count prose updated.
- Deploy procedure → `FASTIFY_APP_PORT=3005` noted; operator must verify on VPS.

**Placeholder scan:** no TBD/TODO/fill-in-later steps. The token is retrieved from `pass`; the port is concrete but called out for verification.

**Type consistency:** not applicable — deploy configs and tests use strings only.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-16-code-rkroll-blog-plan.md`. Inline execution will proceed task-by-task using `superpowers:executing-plans`.
