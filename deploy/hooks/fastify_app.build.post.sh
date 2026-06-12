#!/bin/bash
# Write the current git commit SHA to git-hash in the build directory so
# the running server can report its version without a .git checkout on the host.
# build-info.ts walks up from its module file to find this file at the app root.
set -euo pipefail

: "${PROJECT_DIR:?PROJECT_DIR not set}"
: "${TMP_DIR:?TMP_DIR not set}"

git -C "$PROJECT_DIR" rev-parse HEAD > "$TMP_DIR/app/git-hash"
echo "  fastify_app.build.post: git-hash = $(cat "$TMP_DIR/app/git-hash")"

# Merge config.env (non-secrets, git-tracked) into the build's secrets.env.
# config.env lines are written first so that secrets.env values win on any
# collision (e.g. if a non-secret key appears in both files).
config_env="$PROJECT_DIR/deploy/config.env"
secrets_env="$TMP_DIR/app/secrets.env"
if [[ -f "$config_env" ]]; then
  if [[ -f "$secrets_env" ]]; then
    merged="$(cat "$config_env" <(echo) "$secrets_env")"
    echo "$merged" > "$secrets_env"
  else
    cp "$config_env" "$secrets_env"
  fi
  echo "  fastify_app.build.post: merged config.env into secrets.env"
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
