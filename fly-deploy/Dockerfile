# syntax=docker/dockerfile:1.7
# Two-stage build for fly.io deploys:
#   1. builder  — installs all deps (incl. native), builds browser bundles
#   2. runtime  — slim image; copies built artifacts; runs the server
#
# Demo data is NOT baked in. Posts are pushed to the running app via
# `site-admin import-wp push` (with Authorization: Bearer $ADMIN_TOKEN)
# after the first deploy. Without a fly volume, the SITE_ROOT contents
# (originals, sidecars, content, db) reset on machine restart — re-run
# the importer or attach a volume in fly.toml [[mounts]].

# ----- Stage 1: builder ------------------------------------------------------
FROM node:22-bookworm-slim AS builder

# python3 + build tools for argon2's node-gyp build (a prebuilt is usually
# available, but having the toolchain present means the install never
# fails on a missing-prebuild day). ca-certificates lets npm fetch.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.browser.json biome.json ./
COPY bin ./bin
COPY src ./src
COPY static ./static
# Bring .git over solely to capture the SHA into a small text file the
# runtime stage can read. Done in its own RUN so the layer is small
# and the heavy .git tree doesn't end up in the runtime image.
COPY .git ./.git
RUN git rev-parse HEAD > /app/git-hash && rm -rf /app/.git

# Build admin + site browser bundles into ./static/{admin,site}.
# (admin/ and site/ are gitignored; this rebuild produces them fresh.)
RUN npm run build

# ----- Stage 2: runtime ------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# ca-certificates so node fetch can reach Google's JWKS (OAuth verifier),
# the WP REST API at roll-along.rkroll.com, etc.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/bin ./bin
COPY --from=builder /app/src ./src
COPY --from=builder /app/static ./static
COPY --from=builder /app/git-hash ./git-hash

ENV NODE_ENV=production \
    SITE_ROOT=/site \
    HOST=0.0.0.0 \
    PORT=3000 \
    LOG_LEVEL=info \
    GIT_HASH_FILE=/app/git-hash \
    GOOGLE_CLIENT_ID=demo-stub-no-one-can-sign-in \
    GOOGLE_CLIENT_SECRET=demo-stub-no-one-can-sign-in
# PUBLIC_BASE_URL and ADMIN_TOKEN come from fly.toml / fly secrets.

EXPOSE 3000

# Init is idempotent — creates SITE_ROOT subdirs + runs migrations on
# first boot, no-ops thereafter (or after a volume re-attach). exec'ing
# server.js means SIGTERM from fly hits node directly, not a sh wrapper.
CMD ["sh", "-c", "node --no-warnings=ExperimentalWarning --experimental-strip-types bin/site-admin init && exec node --no-warnings=ExperimentalWarning --experimental-strip-types bin/server.js"]
