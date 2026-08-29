# Fly.io demo (retired) — how it worked

The rkr-blog Fly demo ran at `https://rkr-blog.fly.dev` from ~May 2026
until its decommission in August 2026. It was a second deploy target for
the reset → seed → walk cycle, giving the operator a disposable machine
that a mistake could not damage (the real site, roll-along.rkroll.com,
was never reset). This file records how that deployment was configured;
none of it is currently live.

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
  created once via the dashboard or `fly volumes create rkr_data
  --size 1 --region ams`. Without it, Fly refused the deploy. Directory
  shells under `/site/originals/<aa>/<bb>/` survived a reset — only the
  blob files were gone.
- `auto_stop_machines = false` kept the single machine warm so the
  volume stayed attached.

## Config files

- `fly.toml` — app, region, `[build]` pointing at `fly-deploy/Dockerfile`,
  `[env] PUBLIC_BASE_URL=https://rkr-blog.fly.dev`, `[http_service]`
  (internal port 3000, force HTTPS, concurrency soft/hard limits), the
  `[[vm]]` block, and `[[mounts]]`.
- `fly-deploy/Dockerfile` — two-stage build (builder installs all deps
  incl. native + browser bundles; runtime is a slim image copying built
  artifacts). Runtime installed `ca-certificates ffmpeg`. Secrets
  (`ADMIN_TOKEN`, `GOOGLE_CLIENT_ID/SECRET`) came from `fly secrets set
  ...`, overriding Dockerfile defaults. `CMD` ran `bin/site-admin init`
  then `bin/server.js`.
- `.github/workflows/fly-volume.yml` — a one-shot workflow (push to a
  trigger file, or `workflow_dispatch`) that created the `rkr_data`
  volume via the `FLY_API_TOKEN` GitHub secret. Idempotent: skipped if
  a same-named volume already existed in the region.

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
the sole deployment target. `fly.toml`, `fly-deploy/Dockerfile`, and
`.github/workflows/fly-volume.yml` remain in the tree for reference.
