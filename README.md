# rkroll-cms

Single-author CMS with photo-first content model. See [spec.md](./spec.md) for the full design.

## Status

Working through the build order in spec §21:

- Step 1 (skeleton) — done.
- Step 2 (originals + sidecars + `POST /admin/upload`) — done.
- Step 3 (render pipeline + jobs + `GET /img`) — `renderDerivative` landed; jobs + route still in progress.

## Dev quickstart

Requires Node 22.

```bash
npm install
npm run hooks:install                          # one-time: enable .githooks/

SITE_ROOT=$HOME/site bin/site-admin init       # create dirs + run migrations
SITE_ROOT=$HOME/site PORT=3000 npm start       # boot Fastify
curl http://127.0.0.1:3000/health              # → {"ok":true}

npm test                                       # node --test
npm run lint                                   # biome check
npm run lint:fix                               # biome check --write
npm run check                                  # biome check + tests
```

The pre-commit hook (after `npm run hooks:install`) runs `biome check --staged` then the full test suite. Bypass with `git commit --no-verify` only when you know what you're doing.

## Layout

See spec §8. Source under `src/`, tests under `test/` mirroring the source layout, runtime data outside the repo at `$SITE_ROOT` (default `/var/www/site`).
