# Per-Site Deploy Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run three rkr-blog instances (rkr-blog, roll-along, stockademade) from one code tree by splitting deploy configuration per site.

**Architecture:** `deploy.sh` selects a config file via `DEPLOY_SH_CONF`. Shared settings live in `deploy/common.conf`; each site adds identity (`APP_NAME`, `DOMAIN_NAME`, port) plus paths to its own non-secret env file and gitignored secrets file. Every server-side path, systemd unit, and env file already derives from `APP_NAME`, so no deploy.sh module changes are needed — only the repo's own hooks.

**Tech Stack:** Bash (deploy hooks), Node 22 `node:test` (hook tests), Apache, systemd, certbot.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-27-per-site-deploy-config-design.md`.
- Site table — exact values:

  | | rkr-blog | roll-along | stockademade |
  |---|---|---|---|
  | `APP_NAME` | `rkr-blog` | `roll-along` | `stockademade` |
  | `DOMAIN_NAME` | `rkr-blog.rkroll.com` | `roll-along.rkroll.com` | `stockademade.com` |
  | `APACHE_SERVER_ALIASES` | (unset) | (unset) | `www.stockademade.com` |
  | `FASTIFY_APP_PORT` | `3000` | `3001` | `3002` |
  | `SITE_ROOT` | `/var/www/rkr-blog` | `/var/www/roll-along` | `/var/www/stockademade` |
  | `PUBLIC_BASE_URL` | `https://rkr-blog.rkroll.com` | `https://roll-along.rkroll.com` | `https://stockademade.com` |

- `REMOTE_HOST` is `rkr-blog.rkroll.com` (the VPS) for **all three** sites. Never pass `user@host` on the deploy command line — it overrides `REMOTE_HOST`.
- `REMOTE_USER` is `john`. `FASTIFY_APP_USER`/`FASTIFY_APP_GROUP` are `www-data`.
- `SITE_ENV_FILE` and `FASTIFY_APP_SECRETS_FILE` are **repo-relative** paths; `node_app/build.sh:13` sets `content_dir="$PROJECT_DIR"`.
- One Google OAuth client per host. Each site gets its own `ADMIN_TOKEN`.
- Tests run with `npm test` (`node --test` over `test/**/*.test.ts`). Tests are exempt from the 500-line size cap; production source is not.
- The pre-commit hook runs the full gauntlet. If it fails, fix the cause — do not use `--no-verify`.

## File Structure

**Created:**
- `deploy/common.conf` — every setting identical across sites.
- `deploy/sites/rkr-blog.conf`, `deploy/sites/roll-along.conf`, `deploy/sites/stockademade.conf` — per-site identity.
- `deploy/sites/rkr-blog.env`, `deploy/sites/roll-along.env`, `deploy/sites/stockademade.env` — per-site non-secret runtime config.
- `test/deploy/site-config.test.ts` — asserts each site config exports the right values.
- `test/deploy/apache-hook.test.ts` — runs `apache.build.post.sh` and asserts on the generated vhost.

**Modified:**
- `deploy.conf` — becomes a shim sourcing `deploy/sites/rkr-blog.conf`.
- `deploy/hooks/fastify_app.build.post.sh:17` — read `$SITE_ENV_FILE` instead of the hardcoded `deploy/config.env`.
- `deploy/hooks/apache.build.post.sh` — `ServerAlias` support, apex redirect, `SITE_ROOT` guard.
- `deploy/secrets.env.example` — header describes the per-site location.
- `.gitignore` — add `deploy/secrets/`.
- `docs/RUNBOOK.md`, `docs/DEFERRED.md`.

**Deleted:**
- `deploy/config.env` — content moves to `deploy/sites/rkr-blog.env`.

---

### Task 1: Split config into common + per-site (rkr-blog only)

Restructure with **one** site so the change is provably a no-op before new sites exist.

**Files:**
- Create: `deploy/common.conf`, `deploy/sites/rkr-blog.conf`, `deploy/sites/rkr-blog.env`
- Modify: `deploy.conf`, `deploy/hooks/fastify_app.build.post.sh:17`, `.gitignore`
- Delete: `deploy/config.env`
- Test: `test/deploy/site-config.test.ts`

**Model:** `sonnet` — multi-file coordination and a config move that must preserve exact values.

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `deploy/sites/<site>.conf` files that export `APP_NAME`, `DOMAIN_NAME`, `REMOTE_HOST`, `FASTIFY_APP_PORT`, `SITE_ENV_FILE`, `FASTIFY_APP_SECRETS_FILE`, and optionally `APACHE_SERVER_ALIASES`. Tasks 2–4 rely on these names.

- [ ] **Step 1: Write the failing test**

Create `test/deploy/site-config.test.ts`:

```typescript
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..', '..');

/** Source a site config in a clean shell and return its exported vars. */
function loadConfig(relPath: string): Record<string, string> {
  const out = execFileSync(
    'bash',
    ['-c', `set -a; source "$1"; set +a; env`, '--', path.join(REPO, relPath)],
    { encoding: 'utf8', cwd: REPO }
  );
  const vars: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) vars[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return vars;
}

test('rkr-blog site config exports the expected identity', () => {
  const c = loadConfig('deploy/sites/rkr-blog.conf');
  assert.equal(c.APP_NAME, 'rkr-blog');
  assert.equal(c.DOMAIN_NAME, 'rkr-blog.rkroll.com');
  assert.equal(c.REMOTE_HOST, 'rkr-blog.rkroll.com');
  assert.equal(c.FASTIFY_APP_PORT, '3000');
  assert.equal(c.SITE_ENV_FILE, 'deploy/sites/rkr-blog.env');
  assert.equal(c.FASTIFY_APP_SECRETS_FILE, 'deploy/secrets/rkr-blog.secrets.env');
});

test('rkr-blog site config inherits shared settings from common.conf', () => {
  const c = loadConfig('deploy/sites/rkr-blog.conf');
  assert.equal(c.DEPLOY_TYPES, 'letsencrypt apache fastify_app');
  assert.equal(c.REMOTE_USER, 'john');
  assert.equal(c.FASTIFY_APP_USER, 'www-data');
  assert.equal(c.FASTIFY_APP_BASE_PATH, '/opt');
  assert.equal(c.FASTIFY_APP_DATA_PATH, '/var/www');
});

test('root deploy.conf shim resolves to the rkr-blog site', () => {
  const c = loadConfig('deploy.conf');
  assert.equal(c.APP_NAME, 'rkr-blog');
  assert.equal(c.FASTIFY_APP_PORT, '3000');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern='site config|deploy.conf shim'`
Expected: FAIL — `deploy/sites/rkr-blog.conf` does not exist (bash exits non-zero, `execFileSync` throws).

- [ ] **Step 3: Create `deploy/common.conf`**

```bash
# Settings shared by every rkr-blog site. Sourced by deploy/sites/<site>.conf.
# Per-site identity (APP_NAME, DOMAIN_NAME, port, env + secrets paths) lives
# in the site file, never here.

export DEPLOY_TYPES="letsencrypt apache fastify_app"

export REMOTE_USER="john"

# --- Let's Encrypt ----------------------------------------------------------
export LETSENCRYPT_EMAIL="john@rkroll.com"

# --- Apache -----------------------------------------------------------------
# The vhost is written by deploy/hooks/apache.build.post.sh; these values are
# read by that hook and by the stock modules.
export APACHE_MODE="proxy"
export APACHE_SECURITY_HEADERS="no"   # hook writes its own headers block
export APACHE_CACHE_STATIC="no"       # hook writes immutable headers for /cache/ + /static/

# --- Fastify app ------------------------------------------------------------
export FASTIFY_APP_USER="www-data"
export FASTIFY_APP_GROUP="www-data"
export FASTIFY_APP_BASE_PATH="/opt"          # app lands at /opt/<APP_NAME>
export FASTIFY_APP_DATA_PATH="/var/www"      # data at /var/www/<APP_NAME>
export FASTIFY_APP_MAIN_SCRIPT="bin/server.js"
export FASTIFY_APP_NODE_OPTIONS="--no-warnings=ExperimentalWarning --experimental-strip-types"
export FASTIFY_APP_RESTART_POLICY="on-failure"
export FASTIFY_APP_RESTART_SEC="2"
```

- [ ] **Step 4: Create `deploy/sites/rkr-blog.conf`**

```bash
# rkr-blog demo site — https://rkr-blog.rkroll.com
#
# Usage:
#   DEPLOY_SH_CONF=deploy/sites/rkr-blog.conf ~/src/deploy.sh/deploy.sh update .
#
# REMOTE_HOST is set here; do NOT pass a user@host argument — it overrides
# REMOTE_HOST and deploys to the wrong machine.

source "$(dirname "${BASH_SOURCE[0]}")/../common.conf"

export APP_NAME="rkr-blog"
export DOMAIN_NAME="rkr-blog.rkroll.com"
export REMOTE_HOST="rkr-blog.rkroll.com"
export FASTIFY_APP_PORT="3000"

export SITE_ENV_FILE="deploy/sites/rkr-blog.env"
export FASTIFY_APP_SECRETS_FILE="deploy/secrets/rkr-blog.secrets.env"

export APACHE_PROXY_RULES="/:${FASTIFY_APP_PORT}:/"
```

- [ ] **Step 5: Create `deploy/sites/rkr-blog.env` from `deploy/config.env`**

Copy `deploy/config.env` verbatim, changing only the header comment:

```
# Non-secret runtime configuration for the rkr-blog demo site.
# Committed to git — do not put secrets here.
# Secrets live in deploy/secrets/rkr-blog.secrets.env (gitignored). Both
# files are merged into /etc/rkr-blog.env on deploy; secrets win on any
# collision.

SITE_ROOT=/var/www/rkr-blog
PUBLIC_BASE_URL=https://rkr-blog.rkroll.com

OLLAMA_BASE_URL=https://symon.rkroll.com:554/ollama
SPAM_MODEL=llama3.2:3b
SPAM_TIMEOUT_MS=8000
SPAM_MAX_ATTEMPTS=3

SMTP_PORT=587
```

Then delete the old file: `git rm deploy/config.env`

- [ ] **Step 6: Replace `deploy.conf` with a shim**

```bash
#!/bin/bash
# Default deploy target: the rkr-blog demo site.
#
# `deploy.sh update .` deploys rkr-blog.rkroll.com. Deploy another site with:
#   DEPLOY_SH_CONF=deploy/sites/roll-along.conf    ~/src/deploy.sh/deploy.sh update .
#   DEPLOY_SH_CONF=deploy/sites/stockademade.conf  ~/src/deploy.sh/deploy.sh update .
#
# Per-site values live in deploy/sites/<site>.conf; shared values in
# deploy/common.conf. Never pass a user@host argument.

source "$(dirname "${BASH_SOURCE[0]}")/deploy/sites/rkr-blog.conf"
```

- [ ] **Step 7: Point the build hook at `$SITE_ENV_FILE`**

In `deploy/hooks/fastify_app.build.post.sh`, replace line 17:

```bash
config_env="$PROJECT_DIR/deploy/config.env"
```

with:

```bash
: "${SITE_ENV_FILE:?SITE_ENV_FILE not set — deploy/sites/<site>.conf must export it}"
config_env="$PROJECT_DIR/$SITE_ENV_FILE"
```

Also update the comment two lines above it to say `$SITE_ENV_FILE` rather than `config.env`.

- [ ] **Step 8: Add secrets dir to `.gitignore`**

Append after the existing `secrets.env` line (line 25):

```
# Per-site deployment secrets — one file per site, never tracked
deploy/secrets/
```

- [ ] **Step 9: Move the existing secrets file into place**

This file is gitignored, so it is a local-only move:

```bash
mkdir -p deploy/secrets
[ -f secrets.env ] && cp secrets.env deploy/secrets/rkr-blog.secrets.env
```

Keep the original `secrets.env` in place for now — `npm run test:device` reads it (`package.json` `test:device`). Do not delete it.

- [ ] **Step 10: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern='site config|deploy.conf shim'`
Expected: PASS, 3 tests.

- [ ] **Step 11: Verify no value drifted**

Run: `bash -c 'set -a; source deploy.conf; set +a; env | sort' > /tmp/after.env && git stash && bash -c 'set -a; source deploy.conf; set +a; env | sort' > /tmp/before.env; git stash pop; diff /tmp/before.env /tmp/after.env`
Expected: the only differences are the added `SITE_ENV_FILE` and `FASTIFY_APP_SECRETS_FILE`, and `BASH_SOURCE`-derived noise. No changed value for `APP_NAME`, `DOMAIN_NAME`, `REMOTE_HOST`, `REMOTE_USER`, `DEPLOY_TYPES`, `LETSENCRYPT_EMAIL`, or any `FASTIFY_APP_*` / `APACHE_*` key.

- [ ] **Step 12: Commit**

`git rm deploy/config.env` in Step 5 already staged the deletion.

```bash
git add deploy.conf deploy/common.conf deploy/sites/ deploy/hooks/fastify_app.build.post.sh .gitignore test/deploy/site-config.test.ts
git commit -m "refactor(deploy): split config into common.conf + per-site files"
```

---

### Task 2: ServerAlias and apex redirect in the Apache vhost

**Files:**
- Modify: `deploy/hooks/apache.build.post.sh`
- Test: `test/deploy/apache-hook.test.ts`

**Model:** `sonnet` — generated-config correctness with two interacting redirects.

**Interfaces:**
- Consumes: `APACHE_SERVER_ALIASES` from Task 1's site configs (space-separated hostnames, may be unset).
- Produces: a vhost that serves `DOMAIN_NAME` plus every alias, redirecting aliases to `DOMAIN_NAME`. No downstream task depends on internals.

- [ ] **Step 1: Write the failing test**

Create `test/deploy/apache-hook.test.ts`:

```typescript
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const HOOK = path.join(REPO, 'deploy/hooks/apache.build.post.sh');

/** Run the vhost hook with the given env and return the generated config. */
function runHook(env: Record<string, string>): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vhost-'));
  execFileSync('bash', [HOOK], {
    env: {
      PATH: process.env.PATH ?? '',
      TMP_DIR: tmp,
      FASTIFY_APP_DATA_PATH: '/var/www',
      FASTIFY_APP_BASE_PATH: '/opt',
      ...env,
    },
    encoding: 'utf8',
  });
  return fs.readFileSync(path.join(tmp, `${env.APP_NAME}.conf`), 'utf8');
}

const BASE = {
  APP_NAME: 'rkr-blog',
  DOMAIN_NAME: 'rkr-blog.rkroll.com',
  FASTIFY_APP_PORT: '3000',
  SITE_ROOT: '/var/www/rkr-blog',
};

test('vhost omits ServerAlias when no aliases are configured', () => {
  const conf = runHook(BASE);
  assert.ok(!conf.includes('ServerAlias'));
  assert.ok(conf.includes('ServerName rkr-blog.rkroll.com'));
});

test('vhost declares each alias on both the :80 and :443 blocks', () => {
  const conf = runHook({
    ...BASE,
    APP_NAME: 'stockademade',
    DOMAIN_NAME: 'stockademade.com',
    SITE_ROOT: '/var/www/stockademade',
    FASTIFY_APP_PORT: '3002',
    APACHE_SERVER_ALIASES: 'www.stockademade.com',
  });
  const aliasLines = conf.match(/^\s*ServerAlias www\.stockademade\.com$/gm) ?? [];
  assert.equal(aliasLines.length, 2);
});

test('vhost redirects an alias host to the canonical domain over https', () => {
  const conf = runHook({
    ...BASE,
    APP_NAME: 'stockademade',
    DOMAIN_NAME: 'stockademade.com',
    SITE_ROOT: '/var/www/stockademade',
    FASTIFY_APP_PORT: '3002',
    APACHE_SERVER_ALIASES: 'www.stockademade.com',
  });
  assert.ok(conf.includes('RewriteCond %{HTTP_HOST} !^stockademade\\.com$ [NC]'));
  assert.ok(conf.includes('RewriteRule ^(.*)$ https://stockademade.com$1 [R=301,L]'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern='vhost'`
Expected: FAIL — the "omits ServerAlias" test passes (the hook emits none today), and both alias tests fail because no `ServerAlias` line is generated. `SITE_ROOT` is passed in `BASE` but ignored by the hook until Task 3; that is harmless here.

- [ ] **Step 3: Emit `ServerAlias` and the canonical redirect**

In `deploy/hooks/apache.build.post.sh`, after line 20 (`PORT="${FASTIFY_APP_PORT}"`), add:

```bash
# Optional extra hostnames served by this vhost. letsencrypt/start.sh reads the
# same variable to add SAN entries, so cert and vhost stay in agreement.
ALIASES="${APACHE_SERVER_ALIASES:-}"
ALIAS_LINE=""
REDIRECT_BLOCK=""
if [[ -n "$ALIASES" ]]; then
  for a in $ALIASES; do
    ALIAS_LINE+="    ServerAlias ${a}"$'\n'
  done
  # Escape dots for the regex-matched Host check.
  canonical_re="${DOMAIN_NAME//./\\.}"
  REDIRECT_BLOCK="    # Canonical host: send every alias to \${DOMAIN_NAME}.
    RewriteCond %{HTTP_HOST} !^${canonical_re}\$ [NC]
    RewriteRule ^(.*)\$ https://${DOMAIN_NAME}\$1 [R=301,L]
"
fi
```

Then, in the heredoc, insert `${ALIAS_LINE}` immediately after **both** `ServerName ${DOMAIN_NAME}` lines (the `:80` block at line 27 and the `:443` block at line 41). Because `ALIAS_LINE` already ends with a newline when non-empty, write it on its own line with no leading spaces:

```
<VirtualHost *:80>
    ServerName ${DOMAIN_NAME}
${ALIAS_LINE}
```

In the `:443` block, insert `${REDIRECT_BLOCK}` immediately after `RewriteEngine On` (line 58) and before the cache fast-path `RewriteCond`. The redirect must precede the cache rewrite so an alias request never gets served content under the wrong hostname.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern='vhost'`
Expected: PASS, 3 tests.

- [ ] **Step 5: Eyeball the generated stockademade vhost**

Run:
```bash
TMP=$(mktemp -d); TMP_DIR=$TMP APP_NAME=stockademade DOMAIN_NAME=stockademade.com \
  FASTIFY_APP_PORT=3002 FASTIFY_APP_DATA_PATH=/var/www FASTIFY_APP_BASE_PATH=/opt \
  SITE_ROOT=/var/www/stockademade APACHE_SERVER_ALIASES=www.stockademade.com \
  bash deploy/hooks/apache.build.post.sh && cat "$TMP/stockademade.conf"
```
Expected: `ServerAlias www.stockademade.com` under both `ServerName` lines; the redirect block sits directly after `RewriteEngine On` in the `:443` block and before `RewriteCond %{DOCUMENT_ROOT}...`.

- [ ] **Step 6: Commit**

```bash
git add deploy/hooks/apache.build.post.sh test/deploy/apache-hook.test.ts
git commit -m "feat(deploy): ServerAlias + canonical-host redirect in the vhost"
```

---

### Task 3: Guard `SITE_ROOT` against `APP_NAME` drift

A `SITE_ROOT` that doesn't match `/var/www/<APP_NAME>` produces a service that starts and then can't write. Fail at build time instead.

**Files:**
- Modify: `deploy/hooks/apache.build.post.sh`
- Test: `test/deploy/apache-hook.test.ts`

**Model:** `haiku` — single guard, code given verbatim.

**Interfaces:**
- Consumes: `SITE_ROOT` (from the site's env file, exported into the build environment), `FASTIFY_APP_DATA_PATH`, `APP_NAME`.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Write the failing test**

Append to `test/deploy/apache-hook.test.ts`:

```typescript
test('hook rejects a SITE_ROOT that does not match APP_NAME', () => {
  assert.throws(
    () => runHook({ ...BASE, SITE_ROOT: '/var/www/wrong-name' }),
    /SITE_ROOT/
  );
});

test('hook accepts a SITE_ROOT that matches APP_NAME', () => {
  const conf = runHook({ ...BASE, SITE_ROOT: '/var/www/rkr-blog' });
  assert.ok(conf.includes('DocumentRoot /var/www/rkr-blog'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern='SITE_ROOT'`
Expected: FAIL — the reject test fails because the hook currently succeeds with any `SITE_ROOT`.

- [ ] **Step 3: Add the guard**

In `deploy/hooks/apache.build.post.sh`, after the `DATA_DIR` assignment (line 18), add:

```bash
# SITE_ROOT comes from the site's env file and must name the same directory
# the systemd unit owns. A mismatch yields a service that starts and then
# cannot write — expensive to diagnose, cheap to catch here.
: "${SITE_ROOT:?SITE_ROOT not set — deploy/sites/<site>.env must set it}"
if [[ "$SITE_ROOT" != "$DATA_DIR" ]]; then
  echo "apache.build.post: SITE_ROOT ($SITE_ROOT) != ${FASTIFY_APP_DATA_PATH}/${APP_NAME} ($DATA_DIR)" >&2
  exit 1
fi
```

- [ ] **Step 4: Run the full deploy test file**

Run: `npm test -- --test-name-pattern='vhost|SITE_ROOT'`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add deploy/hooks/apache.build.post.sh test/deploy/apache-hook.test.ts
git commit -m "feat(deploy): fail the build when SITE_ROOT and APP_NAME disagree"
```

---

### Task 4: Add roll-along and stockademade site configs

**Files:**
- Create: `deploy/sites/roll-along.conf`, `deploy/sites/roll-along.env`, `deploy/sites/stockademade.conf`, `deploy/sites/stockademade.env`
- Modify: `deploy/secrets.env.example`
- Test: `test/deploy/site-config.test.ts`

**Model:** `haiku` — repeats an established pattern with values given verbatim.

**Interfaces:**
- Consumes: `deploy/common.conf` and the `deploy/sites/<site>.conf` shape from Task 1; `APACHE_SERVER_ALIASES` from Task 2.
- Produces: two deployable site configs.

- [ ] **Step 1: Write the failing test**

Append to `test/deploy/site-config.test.ts`:

```typescript
test('roll-along site config exports the expected identity', () => {
  const c = loadConfig('deploy/sites/roll-along.conf');
  assert.equal(c.APP_NAME, 'roll-along');
  assert.equal(c.DOMAIN_NAME, 'roll-along.rkroll.com');
  assert.equal(c.REMOTE_HOST, 'rkr-blog.rkroll.com');
  assert.equal(c.FASTIFY_APP_PORT, '3001');
  assert.equal(c.SITE_ENV_FILE, 'deploy/sites/roll-along.env');
  assert.equal(c.FASTIFY_APP_SECRETS_FILE, 'deploy/secrets/roll-along.secrets.env');
  assert.equal(c.APACHE_SERVER_ALIASES, undefined);
});

test('stockademade site config uses the apex domain with a www alias', () => {
  const c = loadConfig('deploy/sites/stockademade.conf');
  assert.equal(c.APP_NAME, 'stockademade');
  assert.equal(c.DOMAIN_NAME, 'stockademade.com');
  assert.equal(c.FASTIFY_APP_PORT, '3002');
  assert.equal(c.APACHE_SERVER_ALIASES, 'www.stockademade.com');
});

test('every site config uses a distinct port and app name', () => {
  const sites = ['rkr-blog', 'roll-along', 'stockademade'].map((s) =>
    loadConfig(`deploy/sites/${s}.conf`)
  );
  const ports = sites.map((c) => c.FASTIFY_APP_PORT);
  const names = sites.map((c) => c.APP_NAME);
  assert.equal(new Set(ports).size, 3);
  assert.equal(new Set(names).size, 3);
});

test('every site env file sets SITE_ROOT to /var/www/<APP_NAME>', () => {
  for (const site of ['rkr-blog', 'roll-along', 'stockademade']) {
    const env = loadConfig(`deploy/sites/${site}.env`);
    assert.equal(env.SITE_ROOT, `/var/www/${site}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern='roll-along|stockademade|distinct port|SITE_ROOT to'`
Expected: FAIL — `deploy/sites/roll-along.conf` does not exist.

- [ ] **Step 3: Create `deploy/sites/roll-along.conf`**

```bash
# roll-along — https://roll-along.rkroll.com (replaces the WordPress site)
#
# Usage:
#   DEPLOY_SH_CONF=deploy/sites/roll-along.conf ~/src/deploy.sh/deploy.sh update .
#
# REMOTE_HOST is the VPS, not this site's public domain. Do NOT pass a
# user@host argument — it overrides REMOTE_HOST.

source "$(dirname "${BASH_SOURCE[0]}")/../common.conf"

export APP_NAME="roll-along"
export DOMAIN_NAME="roll-along.rkroll.com"
export REMOTE_HOST="rkr-blog.rkroll.com"
export FASTIFY_APP_PORT="3001"

export SITE_ENV_FILE="deploy/sites/roll-along.env"
export FASTIFY_APP_SECRETS_FILE="deploy/secrets/roll-along.secrets.env"

export APACHE_PROXY_RULES="/:${FASTIFY_APP_PORT}:/"
```

- [ ] **Step 4: Create `deploy/sites/roll-along.env`**

```
# Non-secret runtime configuration for roll-along.
# Committed to git — do not put secrets here.
# Secrets live in deploy/secrets/roll-along.secrets.env (gitignored). Both
# files are merged into /etc/roll-along.env on deploy; secrets win on any
# collision.

SITE_ROOT=/var/www/roll-along
PUBLIC_BASE_URL=https://roll-along.rkroll.com

OLLAMA_BASE_URL=https://symon.rkroll.com:554/ollama
SPAM_MODEL=llama3.2:3b
SPAM_TIMEOUT_MS=8000
SPAM_MAX_ATTEMPTS=3

SMTP_PORT=587
```

- [ ] **Step 5: Create `deploy/sites/stockademade.conf`**

```bash
# stockademade — https://stockademade.com (replaces the WordPress site)
#
# The apex is canonical; www.stockademade.com is a SAN on the same cert and
# 301s to the apex (see deploy/hooks/apache.build.post.sh).
#
# Usage:
#   DEPLOY_SH_CONF=deploy/sites/stockademade.conf ~/src/deploy.sh/deploy.sh update .
#
# REMOTE_HOST is the VPS, not this site's public domain. Do NOT pass a
# user@host argument — it overrides REMOTE_HOST.

source "$(dirname "${BASH_SOURCE[0]}")/../common.conf"

export APP_NAME="stockademade"
export DOMAIN_NAME="stockademade.com"
export REMOTE_HOST="rkr-blog.rkroll.com"
export FASTIFY_APP_PORT="3002"
export APACHE_SERVER_ALIASES="www.stockademade.com"

export SITE_ENV_FILE="deploy/sites/stockademade.env"
export FASTIFY_APP_SECRETS_FILE="deploy/secrets/stockademade.secrets.env"

export APACHE_PROXY_RULES="/:${FASTIFY_APP_PORT}:/"
```

- [ ] **Step 6: Create `deploy/sites/stockademade.env`**

```
# Non-secret runtime configuration for stockademade.
# Committed to git — do not put secrets here.
# Secrets live in deploy/secrets/stockademade.secrets.env (gitignored). Both
# files are merged into /etc/stockademade.env on deploy; secrets win on any
# collision.

SITE_ROOT=/var/www/stockademade
PUBLIC_BASE_URL=https://stockademade.com

OLLAMA_BASE_URL=https://symon.rkroll.com:554/ollama
SPAM_MODEL=llama3.2:3b
SPAM_TIMEOUT_MS=8000
SPAM_MAX_ATTEMPTS=3

SMTP_PORT=587
```

- [ ] **Step 7: Update the secrets template header**

Replace the header of `deploy/secrets.env.example` (through the `Never commit it.` line) with:

```
# Template for a site's secrets file. One file per site.
#
# Non-secret config (SITE_ROOT, PUBLIC_BASE_URL, SPAM_*, SMTP_PORT…) lives
# in deploy/sites/<site>.env (committed to git). This file holds only secrets.
#
# Instructions:
#   cp deploy/secrets.env.example deploy/secrets/<site>.secrets.env
#   # fill in values below
#   DEPLOY_SH_CONF=deploy/sites/<site>.conf ~/src/deploy.sh/deploy.sh init .
#
# deploy/secrets/ is gitignored. Never commit these files.
```

And replace the Google OAuth comment with:

```
# Google OAuth app credentials (https://console.cloud.google.com/apis/credentials).
# One client per host — do not share a client between sites.
# Authorised redirect URI: https://<site-domain>/auth/google/callback
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern='site config|deploy.conf shim|roll-along|stockademade|distinct port|SITE_ROOT to'`
Expected: PASS, 7 tests.

- [ ] **Step 9: Commit**

```bash
git add deploy/sites/ deploy/secrets.env.example test/deploy/site-config.test.ts
git commit -m "feat(deploy): add roll-along and stockademade site configs"
```

---

### Task 5: Update the runbook and backlog

**Files:**
- Modify: `docs/RUNBOOK.md`, `docs/DEFERRED.md`

**Model:** `haiku` — prose edits with the content specified.

**Interfaces:**
- Consumes: the config layout from Tasks 1 and 4.
- Produces: nothing.

- [ ] **Step 1: Add a "Deploying a site" section to `docs/RUNBOOK.md`**

Insert before the existing `## Reset → seed → walk` section:

````markdown
## Deploying a site

Three sites run from this one tree, each as its own systemd service.

| Site | Domain | `APP_NAME` | Port |
|---|---|---|---|
| demo | rkr-blog.rkroll.com | `rkr-blog` | 3000 |
| roll-along | roll-along.rkroll.com | `roll-along` | 3001 |
| stockademade | stockademade.com (`www.` 301s to apex) | `stockademade` | 3002 |

```bash
# the demo site — deploy.conf defaults to it
~/src/deploy.sh/deploy.sh update .

# any other site
DEPLOY_SH_CONF=deploy/sites/roll-along.conf ~/src/deploy.sh/deploy.sh update .
```

Never pass a `user@host` argument; each site config sets `REMOTE_HOST` to
the VPS, and an argument overrides it.

### First deploy of a new site

1. Create a Google OAuth client for the host, authorised redirect URI
   `https://<domain>/auth/google/callback`. One client per host.
2. `cp deploy/secrets.env.example deploy/secrets/<site>.secrets.env` and
   fill it in; generate `ADMIN_TOKEN` with `openssl rand -hex 32`.
3. Point DNS at the VPS — certbot's webroot challenge needs the name to
   resolve before `init` runs.
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
````

- [ ] **Step 2: Add the permalink item to `docs/DEFERRED.md`**

Under a new `## Deployment` heading (after `## Security`):

```markdown
## Deployment

- **Legacy WordPress permalinks 404** — both migrated sites used
  `/%year%/%monthnum%/%day%/%postname%/`; rkr-blog serves `/:slug`.
  Import preserves slugs, so breakage is limited to ~47 in-content links
  (29 roll-along, 18 stockademade) plus external inbound links. _Revisit
  when:_ those links matter; fix is a `GET /:y/:m/:d/:slug` route that
  301s to `/:slug` when the slug is a published post.
```

- [ ] **Step 3: Verify the docs build clean**

Run: `npm run lint`
Expected: PASS (biome does not check markdown, but this confirms nothing else broke).

- [ ] **Step 4: Commit**

```bash
git add docs/RUNBOOK.md docs/DEFERRED.md
git commit -m "docs: per-site deploy procedure and legacy-permalink backlog item"
```

---

### Task 6: Verify the demo deploy is a no-op, then delete the spec and plan

The refactor's whole safety argument is that the demo site is unaffected. Prove it on the real host before the branch merges.

**Files:**
- Delete: `docs/superpowers/specs/2026-07-27-per-site-deploy-config-design.md`, `docs/superpowers/plans/2026-07-27-per-site-deploy-config.md`

**Model:** `opus` — judgement about whether a live deploy actually succeeded, and what to do if it didn't.

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: a merged branch.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS. Note any pre-existing flakes listed in `docs/DEFERRED.md` under "Test coverage" — those are known and not caused by this branch.

- [ ] **Step 2: Deploy the demo site**

Run: `~/src/deploy.sh/deploy.sh update .`
Expected: completes without error; the build log shows
`fastify_app.build.post: merged config.env into secrets.env` and
`apache.build.post: custom rkr-blog vhost written`.

- [ ] **Step 3: Confirm the demo site is unchanged**

Run:
```bash
curl -s -o /dev/null -w '%{http_code}\n' https://rkr-blog.rkroll.com/
ssh john@rkr-blog.rkroll.com 'systemctl is-active rkr-blog; sudo grep -c SITE_ROOT /etc/rkr-blog.env'
```
Expected: `200`, `active`, `1`.

**If the deploy fails, stop.** Do not proceed to the new sites — the refactor is wrong and needs fixing first.

- [ ] **Step 4: Delete the working documents**

Per the repo convention, specs and plans are deleted in the final commit before merge; what matters has already landed in `docs/RUNBOOK.md` and `docs/DEFERRED.md`.

```bash
git rm docs/superpowers/specs/2026-07-27-per-site-deploy-config-design.md \
       docs/superpowers/plans/2026-07-27-per-site-deploy-config.md
git commit -m "chore: drop per-site deploy spec and plan (landed in RUNBOOK)"
```

- [ ] **Step 5: Report status**

Report to the user: tests passing, demo deploy verified as a no-op, and the two new sites ready to `init` once their DNS, OAuth clients, and secrets files exist. Rolling out roll-along and stockademade is an operator action requiring credentials — it is not part of this branch.

---

## Notes for the executor

- Tasks 1–5 are pure repo changes and need no VPS access. Task 6 needs SSH to the VPS and must not be skipped.
- `deploy/secrets/*.secrets.env` files are gitignored and must be created by hand; no task creates their contents.
- The `deploy/config.env` → `deploy/sites/rkr-blog.env` move must preserve values exactly. Step 11 of Task 1 exists to catch a typo there.
