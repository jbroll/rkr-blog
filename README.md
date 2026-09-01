<h1> rkr-blog - simple offline blogging </h1>
<img style="z-index=100" src="docs/rkr-blog.png" alt="rkr-blog icon" align="right" width="40%"/>


A blog where writing and images work together. Bring in photos from your desktop, Google Drive, OneDrive, or any URL; arrange them in rich layouts; publish. No markup, no plugins, no external services.

Authoring entirely from the browser. Runs on any Node 22 host — no other services required.

## Works offline

Authors can write, import and edit images without a connection. Changes sync automatically when connectivity returns. A status indicator shows what is pending. Pinned posts are available locally at any time.

## Comments

Anonymous readers can leave comments. Submissions are optionally filtered for spam automatically using a configurable LLM, with a moderation queue for manual review. New comments trigger an email notification to the site owner.

## Images

Import from four sources — local files, any public URL, Google Drive, and OneDrive — directly into the editor. Duplicate images from any source are detected and stored once. Quality and resolution settings are configurable in settings; PNG files are preserved losslessly.

All image layouts share the same insertion and settings panel. Choose the arrangement from the toolbar:

- **Justified rows** — rows of images at a uniform height, each image at its natural width
- **Masonry columns** — columns of images at a uniform width, each image at its natural height
- **Grid** — fixed rows and columns at a consistent aspect ratio
- **Carousel** — horizontal scroll with keyboard navigation and optional autoplay; activates automatically when images exceed the grid layout capacity
- **Full-bleed** — edge to edge across the viewport
- **Inline** — flows with surrounding text

Crop, rotate, flip, resize, and correct perspective without leaving the editor. Every operation is recorded as a named step that can be removed, undone, or redone — and the edit history persists across browser reloads. The stored original is never overwritten; remove any step and the image regenerates from it.

## Images served responsively

Every image is served in multiple sizes and modern formats so each browser and screen gets the right file.

---

## Stack

| | |
|---|---|
| Runtime | Node 22 |
| Language | TypeScript |
| Database | SQLite |
| Auth | Google OAuth |
| Deployment | Apache (VPS) |

---

## Also included

- **Full-text search** — search across all published posts
- **Tags** — tag posts and filter by tag on the index; autocomplete in the editor
- **Eight built-in themes** — switch from settings
- **WordPress importer** — migrate posts and images from an existing WordPress site
- **Author access** — invite authors by email address; owner and editor roles
- **Operator CLI** — tools for rendering, garbage collection, reindexing, and user management
- **Standalone image editor** (`apps/image-pwa`) — the editor's crop / rotate / perspective pipeline as an installable offline PWA, over the shared `packages/image-edit`. Off by default; see [docs/RUNBOOK.md](./docs/RUNBOOK.md)

---

## Requirements

Node 22 and a reverse proxy. Apache configuration and a Dockerfile are included.

## Quick start

```bash
git clone <repo> /opt/rkr-blog
cd /opt/rkr-blog && npm ci && npm run build
SITE_ROOT=/var/www/site bin/site-admin init
# reverse proxy vhost is generated at deploy time — see deploy/hooks/
systemctl enable --now rkr-blog
```

Full setup: [docs/developer-quickstart.md](./docs/developer-quickstart.md)

---

## Docs

- [docs/spec.md](./docs/spec.md) — what the app does
- [docs/implementation.md](./docs/implementation.md) — how it's built
- [docs/developer-quickstart.md](./docs/developer-quickstart.md) — local setup
- [docs/RUNBOOK.md](./docs/RUNBOOK.md) — operator procedures for the live site
- [docs/TESTING.md](./docs/TESTING.md) — writing and debugging the e2e suite
- [docs/theming.md](./docs/theming.md) — the CSS theme contract
- [docs/backlog.md](./docs/backlog.md) — outstanding work
- [docs/DEFERRED.md](./docs/DEFERRED.md) — known gaps, deliberately unaddressed, with revisit triggers
- [docs/WILLNOTFIX.md](./docs/WILLNOTFIX.md) — deliberate choices, not deferred work
