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
