# Fly.io demo (retired) — how it worked

The rkr-blog Fly demo ran at `https://rkr-blog.fly.dev` from ~May 2026
until its decommission on 2026-08-29. It was a second deploy target for
the reset → seed → walk cycle, giving the operator a disposable machine
that a mistake could not damage (the real site, roll-along.rkroll.com,
was never reset). None of it is live, and the config files were removed
from the tree; they are reproduced in full below so the demo can be
rebuilt by writing them back to the paths shown.

## App & machine

- Fly app name: `rkr-blog` (Fly's GitHub App auto-deployed on push to
  `main`; no `fly` CLI needed on the developer side).
- Machine: `shared-cpu-2x`, 2 GB RAM, pinned to region `ams`. Sized for
  the image-render pipeline — a reseed pre-warms variants for every
  image of every post, and sharp decodes sources into uncompressed
  buffers before resizing. The earlier 512 MB machine OOM'd mid-burst
  on a 24-image post of 12-MP photos.
- Persistent state lived on a Fly volume named `rkr_data`, mounted at
  `/site` (= `SITE_ROOT`). The volume had to exist before deploy;
  created once via the dashboard, `fly volumes create rkr_data --size 1
  --region ams`, or the one-shot workflow below. Without it, Fly refused
  the deploy. Directory shells under `/site/originals/<aa>/<bb>/`
  survived a reset — only the blob files were gone.
- `auto_stop_machines = false` kept the single machine warm so the
  volume stayed attached.
- Secrets (`ADMIN_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`)
  came from `fly secrets set ...`, overriding the Dockerfile defaults.

## Rebuild steps

1. Write the four files below to their paths.
2. Connect the repo to Fly's GitHub App (dashboard → Launch from GitHub)
   with app name `rkr-blog`.
3. Create a Fly deploy token, store it as the `FLY_API_TOKEN` GitHub
   Actions secret, and run the volume workflow once (push a change to
   `.github/triggers/fly-volume`, or trigger `workflow_dispatch`).
4. `fly secrets set ADMIN_TOKEN=... GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...`
5. Push to `main`; the GitHub App deploys.

## `fly.toml`

```toml
# fly.io config for rkr-blog. Connected via fly's GitHub App, so a
# push to this branch triggers an auto-deploy. No fly CLI needed on
# the developer side.

app = "rkr-blog"
# Fly auto-placed the initial machine in ams (closer to the operator),
# so we keep the app pinned there. Changing primary_region after a
# machine exists doesn't move the machine — but it does decide where
# new machines land + where Fly looks for the volume to mount.
primary_region = "ams"

[build]
  dockerfile = "fly-deploy/Dockerfile"

[env]
  PUBLIC_BASE_URL = "https://rkr-blog.fly.dev"
  # ADMIN_TOKEN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET are set via
  # `fly secrets set ...` (or the dashboard); they override the
  # Dockerfile defaults at runtime.

[http_service]
  internal_port = 3000
  force_https = true
  # Demo persistence: keep the single machine warm so /site (a Fly
  # volume — see [[mounts]] below) stays attached. Without this,
  # auto-stop after idle would recycle the machine and any state not
  # on the volume would die. With the volume mounted at /site, posts
  # + originals + sidecars + sqlite all survive.
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1
  # Cold-start hits the JIT cache + node:sqlite open + migrate; budget
  # for that without 502'ing the first request after wake.
  [http_service.concurrency]
    type = "requests"
    soft_limit = 80
    hard_limit = 100

[[vm]]
  # 2 shared CPU + 2 GB. Sized for the image-render pipeline: a fresh
  # reseed pre-warms variants for every image referenced by every
  # post (multi-image figures × multiple output formats × multiple
  # widths), and sharp decodes the source into uncompressed buffers
  # before resizing. A 24-image post with 12-MP source photos chewed
  # past the previous 512 MB ceiling and the machine OOM'd mid-burst.
  # Adjust here (fly.toml, not the Fly UI) and re-deploy — Fly
  # auto-deploys this branch via the GitHub app on every push.
  size = "shared-cpu-2x"
  memory = "2gb"

# Persistent data lives on a Fly volume mounted at SITE_ROOT (=/site).
# The volume must exist before deploy: create it once in the Fly
# dashboard (Volumes → New volume) or via `fly volumes create rkr_data
# --size 1 --region ams`. Without the volume Fly refuses the deploy.
[[mounts]]
  source = "rkr_data"
  destination = "/site"
  initial_size = "1gb"
```

## `fly-deploy/Dockerfile`

```dockerfile
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
# the WP REST API at roll-along.rkroll.com, etc. ffmpeg + ffprobe drive
# the video pipeline (transcode + poster extraction + ingest probing).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates ffmpeg \
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
```

## `.dockerignore`

```
# Keep the build context small — Docker uploads everything that isn't
# excluded here to the daemon (or fly.io's remote builder) before the
# build starts.

node_modules
coverage
.nyc_output
*.log

# Build artifacts that get rebuilt inside the image (npm run build).
static/admin
static/site

# Editor noise.
.gitignore
.githooks
# .git is intentionally NOT ignored — the builder reads it to bake the
# current commit SHA into /app/git-hash so /health can report what's
# deployed. The .git tree is a few MB; only consulted in stage 1.
.idea
.vscode
.DS_Store
*.swp

# Tests + dev fixtures don't ship to runtime. (npm ci still installs
# devDependencies in the builder stage; this just avoids COPYing the
# /test tree onto the image.)
test

# Local site roots, env files, ad-hoc docs that aren't needed at
# runtime.
site
var
.env
.env.*
DEFERRED.md
developer-quickstart.md
```

## `.github/workflows/fly-volume.yml`

Fly's GitHub App deploys but does not create volumes, and `[[mounts]]
initial_size` only auto-creates on scale-out. This one-shot workflow
created `rkr_data`. It ran on `workflow_dispatch` or on a push to
`main` touching the workflow file or the empty trigger file
`.github/triggers/fly-volume`. Re-running when the volume already
existed logged a message and exited 0.

```yaml
name: Create Fly volume (one-shot)

on:
  workflow_dispatch:
    inputs:
      volume_name:
        description: 'Volume name (must match fly.toml [[mounts]].source)'
        required: true
        default: 'rkr_data'
      size_gb:
        description: 'Volume size in GB'
        required: true
        default: '1'
      region:
        description: 'Fly region (must match primary_region in fly.toml)'
        required: true
        default: 'ams'
  push:
    branches: [main]
    paths:
      - '.github/workflows/fly-volume.yml'
      - '.github/triggers/fly-volume'

jobs:
  create-volume:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up flyctl
        uses: superfly/flyctl-actions/setup-flyctl@master

      - name: Create volume (idempotent)
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
          # Inputs are only present on workflow_dispatch; fall back to
          # the same defaults so a push-triggered run gets the right values.
          NAME: ${{ inputs.volume_name || 'rkr_data' }}
          SIZE: ${{ inputs.size_gb || '1' }}
          REGION: ${{ inputs.region || 'ams' }}
        run: |
          set -euo pipefail
          app=rkr-blog
          echo "Trigger: ${{ github.event_name }} ; ref: ${{ github.ref }}"
          echo "Volume='$NAME' Size='$SIZE'GB Region='$REGION' App='$app'"

          # Idempotency: only skip when a volume of this name already
          # exists in the TARGET region. A same-named volume in another
          # region is a region-mismatch problem we'd rather surface by
          # creating the right one (the orphan can be deleted later).
          if flyctl volumes list --app "$app" --json \
            | jq -e --arg n "$NAME" --arg r "$REGION" \
                '.[] | select(.Name == $n and .Region == $r)' >/dev/null; then
            echo "Volume '$NAME' already exists in $REGION on $app; nothing to do."
            flyctl volumes list --app "$app"
            exit 0
          fi

          echo "Creating volume '$NAME' ${SIZE}GB in $REGION for $app..."
          flyctl volumes create "$NAME" \
            --app "$app" \
            --size "$SIZE" \
            --region "$REGION" \
            --yes

          echo "Done. Current volumes:"
          flyctl volumes list --app "$app"
```

## Ops against the demo

`ADMIN_TOKEN` for the demo lived in the repo's gitignored `secret.env`
(`set -a; . secret.env; set +a`) and in Fly's secret store. The reset →
seed → walk cycle ran against it:

```bash
bin/site-admin reset --to https://rkr-blog.fly.dev --token "$ADMIN_TOKEN" --force
bin/site-admin import-wp push "$WP_BASE" "$slug" --to https://rkr-blog.fly.dev --token "$ADMIN_TOKEN"
scripts/walk-site.sh https://rkr-blog.fly.dev
```

`fly.toml` pinned the public URL to `rkr-blog.fly.dev`; `rkr-blog.fly.io`
redirected but wasn't canonical.

## Diagnostics

- `fly status --app rkr-blog` — machine size + state.
- `fly logs --app rkr-blog` — app logs; kernel OOM showed as `Killed
  (out of memory)` when the VM cap was hit.
- `fly secrets list --app rkr-blog` — secret names (digests, not values).

## Decommission

The demo was retired 2026-08-29. The app and volume were destroyed;
`rkr-blog.fly.dev` no longer resolves, and no Fly deployment has run
since. The VPS deploy at roll-along.rkroll.com / rkr-blog.rkroll.com is
the sole deployment target. The hand-written Apache vhost and systemd
unit that once sat beside the Dockerfile under `fly-deploy/` were the
pre-`deploy.sh` VPS originals; the live equivalents are generated by
`deploy/hooks/`, and the originals are in git history before 2026-09-01.
