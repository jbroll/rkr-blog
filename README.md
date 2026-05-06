# rkroll-cms

Single-author CMS with photo-first content model. See [spec.md](./spec.md) for the full design.

## Status

Step 1 (skeleton) of the build order in spec §21:

- repo layout per §8
- `lib/db.js` wrapper over `node:sqlite`
- `migrations/001_initial.sql` per §15
- `bin/site-admin` with `init` / `migrate` / `server` subcommands
- `bin/server.js` Fastify entry point with `GET /health`
- `deploy/apache.conf` and `deploy/systemd.service`

## Dev quickstart

Requires Node 22.

```bash
npm install
SITE_ROOT=$HOME/site bin/site-admin init       # create dirs + run migrations
SITE_ROOT=$HOME/site PORT=3000 npm start       # boot Fastify
curl http://127.0.0.1:3000/health              # → {"ok":true}

npm test                                       # node --test
```

## Layout

See spec §8. Source under `src/`, tests under `test/` mirroring the source layout, runtime data outside the repo at `$SITE_ROOT` (default `/var/www/site`).
