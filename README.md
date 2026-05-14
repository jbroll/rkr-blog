# rkr-blog

Self-hosted blog built for photography. Your originals are never touched. Edit and publish from the browser.

## For the author

Clean editor — write prose, drop in photos. No markdown syntax in your face. Crop, rotate, and straighten images right there in the browser. Save once, publish everything.

Import from Google Drive, OneDrive, a URL, or your local machine. Keep writing offline; it syncs when you reconnect.

## For the reader

Pages load fast. Images render once and serve from disk with long-cache headers. The service worker caches pages for instant repeat visits and offline reading.

## Stack

Node 22, Fastify, SQLite, Apache. No bundler, no ORM, no Redis. TypeScript runs as-is via `--experimental-strip-types`.

## Docs

- **[docs/spec.md](./docs/spec.md)** — what the app does
- **[docs/implementation.md](./docs/implementation.md)** — how it's built
- **[docs/developer-quickstart.md](./docs/developer-quickstart.md)** — local setup
