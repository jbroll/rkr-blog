#!/bin/bash
# Write the current git commit SHA to git-hash in the build directory so
# the running server can report its version without a .git checkout on the host.
# build-info.ts walks up from its module file to find this file at the app root.
set -euo pipefail

: "${PROJECT_DIR:?PROJECT_DIR not set}"
: "${TMP_DIR:?TMP_DIR not set}"

git -C "$PROJECT_DIR" rev-parse HEAD > "$TMP_DIR/app/git-hash"
echo "  fastify_app.build.post: git-hash = $(cat "$TMP_DIR/app/git-hash")"
