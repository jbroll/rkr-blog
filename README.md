# rkr-blog

A blog where writing and images work together naturally. Bring in photos from your desktop, Google Drive, OneDrive, or any URL; arrange them in rich layouts; publish. No markup, no plugins, no external services.

Runs on any Node 22 host. No separate database to install.

---

## Images from anywhere

Import photos directly into the editor from four sources: local files, any public URL, Google Drive, and OneDrive. Duplicate images from any source are detected and stored once.

Quality and resolution settings are configurable in settings. PNG files are preserved losslessly.

## Six layout modes, one set of controls

All image layouts share the same insertion and settings panel. Choose the arrangement from the toolbar:

- **Justified rows** — rows of images at a uniform height, each image at its natural width
- **Masonry columns** — columns of images at a uniform width, each image at its natural height
- **Grid** — fixed rows and columns at a consistent aspect ratio
- **Carousel** — horizontal scroll with keyboard navigation and optional autoplay; activates automatically when images exceed the grid layout capacity
- **Full-bleed** — edge to edge across the viewport
- **Inline** — flows with surrounding text

## In-browser image editing

Crop, rotate, flip, resize, and correct perspective without leaving the editor. Every operation is recorded as a named step; steps can be removed individually, undone, or redone. The edit history persists across browser reloads.

## Non-destructive

Edits are stored as reversible steps alongside the image. The stored original is never overwritten. Remove any step and the image regenerates from the original.

## Fast by default

Images are automatically served in multiple sizes and modern formats so every browser and screen gets the right file. Pages load fast on repeat visits, and readers can access previously visited posts without a connection.

## Offline editing

Changes queue locally when offline and sync automatically when the connection returns. A status indicator shows what is pending. Pinned posts are available locally without a network connection.

---

## Stack

| | |
|---|---|
| Runtime | Node 22 |
| Language | TypeScript |
| Database | SQLite |
| Auth | Google OAuth |
| Deployment | Apache, Docker / Fly.io |

---

## Also included

- **Eight built-in themes** — switch from settings
- **WordPress importer** — migrate posts and images from an existing WordPress site
- **Comments** — with spam filtering via a local LLM (Ollama)
- **Invite-only access** — add collaborators by email address; owner and editor roles
- **Operator CLI** — tools for rendering, garbage collection, reindexing, and user management

---

## Requirements

Node 22 and a reverse proxy. Apache configuration and a Dockerfile are included.

## Quick start

```bash
git clone <repo> /opt/rkr-blog
cd /opt/rkr-blog && npm ci
SITE_ROOT=/var/www/site bin/site-admin init
# configure reverse proxy from deploy/apache.conf
systemctl enable --now rkroll
```

Full setup: [docs/developer-quickstart.md](./docs/developer-quickstart.md)

---

## Docs

- [docs/spec.md](./docs/spec.md) — what the app does
- [docs/implementation.md](./docs/implementation.md) — how it's built
- [docs/developer-quickstart.md](./docs/developer-quickstart.md) — local setup
