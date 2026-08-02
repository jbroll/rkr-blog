#!/bin/bash
# Write the current git commit SHA to git-hash in the build directory so
# the running server can report its version without a .git checkout on the host.
# build-info.ts walks up from its module file to find this file at the app root.
set -euo pipefail

: "${PROJECT_DIR:?PROJECT_DIR not set}"
: "${TMP_DIR:?TMP_DIR not set}"
: "${APP_NAME:?APP_NAME not set}"
: "${FASTIFY_APP_DATA_PATH:?FASTIFY_APP_DATA_PATH not set}"

git -C "$PROJECT_DIR" rev-parse HEAD > "$TMP_DIR/app/git-hash"
echo "  fastify_app.build.post: git-hash = $(cat "$TMP_DIR/app/git-hash")"

# The secrets file is operator-created and gitignored (see
# deploy/secrets.env.example) — it does not exist until someone runs it
# through that template. Without this check a missing file is silently
# dropped: node_app/build.sh's `[[ -f ]]` copy is a no-op, the merge below
# falls back to the site env alone, and the site comes up with no
# GOOGLE_CLIENT_*/ADMIN_TOKEN and no error anywhere.
: "${FASTIFY_APP_SECRETS_FILE:?FASTIFY_APP_SECRETS_FILE not set — deploy/sites/<site>.conf must export it}"
secrets_src="$PROJECT_DIR/$FASTIFY_APP_SECRETS_FILE"
if [[ ! -f "$secrets_src" ]]; then
  echo "fastify_app.build.post: missing secrets file $FASTIFY_APP_SECRETS_FILE — create it from deploy/secrets.env.example before deploying" >&2
  exit 1
fi

# Merge $SITE_ENV_FILE (non-secrets, git-tracked) into the build's secrets.env.
# $SITE_ENV_FILE lines are written first so that secrets.env values win on any
# collision (e.g. if a non-secret key appears in both files).
: "${SITE_ENV_FILE:?SITE_ENV_FILE not set — deploy/sites/<site>.conf must export it}"
config_env="$PROJECT_DIR/$SITE_ENV_FILE"
secrets_env="$TMP_DIR/app/secrets.env"
if [[ -f "$config_env" ]]; then
  if [[ -f "$secrets_env" ]]; then
    merged="$(cat "$config_env" <(echo) "$secrets_env")"
    echo "$merged" > "$secrets_env"
  else
    cp "$config_env" "$secrets_env"
  fi
  echo "  fastify_app.build.post: merged $SITE_ENV_FILE into secrets.env"
fi

# Re-check SITE_ROOT on the artifact that actually ships: the merged
# secrets.env, not $SITE_ENV_FILE alone. apache.build.post.sh's guard runs
# earlier in DEPLOY_TYPES and cannot see this file — and a SITE_ROOT line in
# the secrets file (last-wins, same as systemd's EnvironmentFile parsing)
# would silently override the value that guard approved.
if [[ -f "$secrets_env" ]]; then
  merged_site_root="$(grep -E '^SITE_ROOT=' "$secrets_env" | tail -n1 | cut -d= -f2- | sed -e 's/[[:space:]]*$//' || true)"
  expected_site_root="${FASTIFY_APP_DATA_PATH}/${APP_NAME}"
  if [[ -z "$merged_site_root" ]]; then
    echo "fastify_app.build.post: merged secrets.env has no SITE_ROOT= line — it must set SITE_ROOT" >&2
    exit 1
  fi
  if [[ "$merged_site_root" != "$expected_site_root" ]]; then
    echo "fastify_app.build.post: effective SITE_ROOT ($merged_site_root) in merged secrets.env != ${expected_site_root}" >&2
    exit 1
  fi
fi

# Same last-wins trap for the hostnames. These are non-secret config and
# belong in $SITE_ENV_FILE; a stale copy in the secrets file would silently
# reinstate an old domain, breaking permalinks and the CSRF allowlist with
# nothing in the deploy output to show for it.
if [[ -f "$secrets_env" && -f "$config_env" ]]; then
  for key in PUBLIC_BASE_URL ADMIN_BASE_URL; do
    from_site="$(grep -E "^${key}=" "$config_env" | tail -n1 | cut -d= -f2- | sed -e 's/[[:space:]]*$//' || true)"
    [[ -z "$from_site" ]] && continue
    merged_value="$(grep -E "^${key}=" "$secrets_env" | tail -n1 | cut -d= -f2- | sed -e 's/[[:space:]]*$//' || true)"
    if [[ "$merged_value" != "$from_site" ]]; then
      echo "fastify_app.build.post: effective ${key} ($merged_value) != ${from_site} from $SITE_ENV_FILE — remove the ${key} line from $FASTIFY_APP_SECRETS_FILE" >&2
      exit 1
    fi
  done
fi

# --- Workspace package on the remote ---------------------------------------
# @rkr/image-edit is a file: dependency; node_app/build.sh has already bundled
# its built dist into .bundled-deps and stripped it from the shipped
# package.json. But the shipped package.json still carries the npm `workspaces`
# array (packages/*, apps/*), and those dirs are NOT shipped — remote
# `npm install` would fail globbing them. Strip the workspaces field so the
# remote install is a plain, lockfile-driven production install.
app_pkg="$TMP_DIR/app/package.json"
if [[ -f "$app_pkg" ]]; then
  node -e "
    const fs = require('fs');
    const p = JSON.parse(fs.readFileSync('$app_pkg', 'utf8'));
    delete p.workspaces;
    fs.writeFileSync('$app_pkg', JSON.stringify(p, null, 2) + '\n');
  "
  echo "  fastify_app.build.post: stripped workspaces from shipped package.json"
fi

# --- Standalone image-editor PWA -------------------------------------------
# Build apps/image-pwa and stage its static output under the app tree so it
# ships to /opt/<app>/image-editor; Apache serves it at /image-editor (see
# apache.build.post.sh). node_app/build.sh ran `npm run build` already, so
# packages/image-edit/dist (which the PWA imports) exists.
( cd "$PROJECT_DIR" && npm run --silent build -w @rkr/image-pwa )
pwa_src="$PROJECT_DIR/apps/image-pwa"
pwa_dst="$TMP_DIR/app/image-editor"
mkdir -p "$pwa_dst/dist"
cp "$pwa_src/index.html" "$pwa_src/manifest.webmanifest" "$pwa_dst/"
cp -r "$pwa_src/dist/." "$pwa_dst/dist/"
echo "  fastify_app.build.post: staged image-editor PWA ($(ls "$pwa_dst/dist" | wc -l) dist files)"
