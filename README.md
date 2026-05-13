# rkroll-cms

A self-hosted, single-author CMS built around photography. Markdown is
the canonical content format, but the editor never makes you look at
markdown. Photos are first-class: the original is preserved untouched
and the entire crop / rotate / resample / perspective-rectify pipeline
runs in your browser on a canvas, with results baked once and served
from disk thereafter.

## What it is

- **Single-author** by design. Sign-in is invite-only via Google OAuth;
  no passwords stored, no multi-user features.
- **Markdown + a single `::figure` directive** for layout. Posts are
  plain `.md` files on disk — diff-friendly, scriptable,
  version-controllable. `::figure` covers single images, grids,
  carousels, justified rows, and masonry.
- **Photo pipeline** that records edits as a recipe (`crop / rotate /
  flip / resample / perspective`), keeps the master byte-identical
  forever, and serves cached derivatives directly from Apache. Edits
  apply in the browser via canvas + WebGL; the browser-baked result is
  what the public site displays.
- **No bundler, no ORM, no Redis, no Docker.** Source is TypeScript
  that runs as-is via Node 22's `--experimental-strip-types`. Storage is
  the filesystem + SQLite (`node:sqlite`). HTTP is Fastify behind
  Apache.
- **Imports** from local upload, an arbitrary URL, Google Drive, and
  OneDrive. Provider pickers (not URL parsing) handle selection; the
  server fetches once and dedupes by sha256.
- **Offline-friendly editor.** Drafts and image edits survive a
  network drop: the SPA writes to OPFS, an outbox drains to the
  server on reconnect with per-entry retry + backoff.
- **PWA shell** on the public site: a service worker caches pages
  + immutable image derivatives, so visitors get instant repeat
  loads and offline reads of pages they've already seen.

## Read next

- **[spec.md](./spec.md)** — what the application does. The features
  and behavior an alternate implementation would need to reproduce.
- **[implementation.md](./implementation.md)** — how this codebase
  delivers the spec: stack choices, repo layout, database schema,
  image-pipeline internals, build order.
- **[developer-quickstart.md](./developer-quickstart.md)** — local
  development setup, coding conventions, test/lint/hook configuration,
  command cheatsheet.

## Status

Self-hosted single-author CMS for one site. In production. The image
pipeline (ingest, derivatives, perspective rectify), TipTap editor,
multi-provider image imports, PWA + service-worker shell, and OPFS
offline outbox are all shipped. Run from source on Void / Debian /
Ubuntu; production on Apache 2.4 + Node 22 + SQLite.
