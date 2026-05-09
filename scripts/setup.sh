#!/usr/bin/env bash
# scripts/setup.sh — one-shot environment setup for rkroll-cms.
#
# Idempotent: running twice does no harm. Each step prints what it's
# doing and a brief OK / SKIP. Steps:
#
#   1. npm install              (node_modules — sharp prebuilds, all
#                                tooling: biome, knip, dpdm, c8, esbuild,
#                                tiptap, cropperjs, @playwright/test)
#   2. playwright install       (chromium binary for the e2e suite —
#                                ~110 MB, downloads once into the
#                                Playwright cache)
#   3. hooks:install            (sets git core.hooksPath to .githooks/
#                                so pre-commit runs the gate)
#
# Run via `npm run setup` or `bash scripts/setup.sh`.
#
# What this script does NOT do:
#   * Create a SITE_ROOT or run `bin/site-admin init` — that's a
#     deploy-time choice; see developer-quickstart.md §2.
#   * Install OS packages. Sharp's prebuilds cover Debian / Ubuntu /
#     macOS out of the box; on Void or musl distros, install vips
#     manually before running this script (see Troubleshooting §9).

set -euo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$repo_root"

echo "==> rkroll-cms setup"

echo "[1/3] npm install"
if [ -d node_modules ] && [ -f node_modules/.package-lock.json ]; then
  npm install --silent
else
  npm install
fi

echo "[2/3] playwright install chromium"
# Idempotent: chromium download skips when the version is already cached.
npx --no-install playwright install chromium

echo "[3/3] git hooks"
if [ "$(git config --get core.hooksPath || true)" = ".githooks" ]; then
  echo "  hooksPath already set to .githooks — skip"
else
  npm run --silent hooks:install
fi

echo
echo "Setup complete. Next steps:"
echo "  - Pick a SITE_ROOT (e.g. \$HOME/site) and run \`bin/site-admin init\`"
echo "  - Invite yourself: \`bin/site-admin user invite <email> --role=owner\`"
echo "  - Start the server: \`SITE_ROOT=\$HOME/site PORT=3000 npm start\`"
echo "  - Run the unit tests: \`npm test\` (or \`npm run check\` for full gauntlet)"
echo "  - Run the e2e tests:  \`npm run test:e2e\`"
