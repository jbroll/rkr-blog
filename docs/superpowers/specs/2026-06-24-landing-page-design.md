# rkr-blog landing page — design

Status: **approved (design)** — 2026-06-24

## Summary

Add a static marketing landing page for rkr-blog, matching the rkroll
family of sibling sites (`checklist`, `drop-notes`, `wicketmap`). The
page lives in a new `website/` directory and deploys as a static Apache
site to `rkr-blog-www.rkroll.com`.

The app stays where it is on `rkr-blog.rkroll.com` — nothing about the
app's deploy, domain, or OAuth changes. This is a self-contained
addition.

## Decisions (locked)

- **Landing domain:** `rkr-blog-www.rkroll.com` (new vhost on the same VPS).
- **App domain:** unchanged (`rkr-blog.rkroll.com`).
- **Shape:** checklist-style single `index.html` (hero → feature-card grid
  → footer) plus `about` / `privacy` / `terms` legal pages.
- **Tech:** Tailwind via CDN, no build step. Legal pages are
  hand-authored static HTML (single brand, short pages — no `marked`
  dependency, no generator; `marked` is not installed and a standalone
  build script would trip the `knip` gate).
- **Palette:** crimson `#cf222e` accent on warm paper (`#fdfdfb`),
  matching the app's `default.css` theme. Light-only; same `setTheme`
  console hook the siblings ship.
- **No app CTA for now.** rkr-blog has no "try for free" flow. Omit the
  "Try Free" buttons from nav / hero / footer. CTA wiring to the app is
  deferred (see `docs/DEFERRED.md`).

## Components

### 1. `website/index.html`

Single static file. Sections, top to bottom:

- **Nav** — sticky top bar: rkr-blog icon + wordmark on the left, an
  `About` link on the right (no app CTA). Mobile hamburger toggles a
  stacked menu, same script as the siblings.
- **Hero** — warm-paper band. Headline: photo-first, offline-first
  blogging. One-line subhead. No CTA button.
- **Feature grid** — `md:grid-cols-2 lg:grid-cols-3`, eight cards. Each
  card: icon tile + title + one-line blurb + a small inline-SVG "mini
  illustration" in a tinted area (same construction as checklist). The
  eight features, drawn from `README.md`:
  1. **Photo-first authoring** — import from local files, any URL,
     Google Drive, OneDrive; duplicates stored once.
  2. **Six image layouts** — justified rows · masonry · grid · carousel
     · full-bleed · inline.
  3. **Non-destructive editing** — crop / rotate / flip / resize /
     perspective as named steps; persists across reloads; original never
     overwritten.
  4. **Works offline** — write and edit without a connection; auto-sync
     with a pending indicator; pinned posts available locally.
  5. **Reader comments** — anonymous, optional LLM spam filter,
     moderation queue, email notification to the owner.
  6. **Fast by default** — multiple sizes and modern formats served
     automatically.
  7. **Search · tags · themes** — full-text search, taggable posts,
     eight built-in themes.
  8. **Self-hosted** — Node 22 + SQLite + Google OAuth; no external
     services required.
- **Footer** — dark band: `© rkroll.com`, links to `about` / `privacy`
  / `terms`. No app CTA.

Colour system uses the same CSS-variable block as the siblings so a
single `:root` edit re-themes the page; values set to the crimson /
warm-paper palette.

### 2. Legal pages

`about.html`, `privacy.html`, `terms.html` — hand-authored static HTML
sharing the index page's nav/footer chrome and a `.prose` content block.
No markdown sources, no generator. Privacy copy must reflect the app's
actual data handling: reader comments, Google OAuth sign-in for authors,
owner email notifications, and the optional LLM-based spam filter.

### 3. `website/deploy.conf`

Static-site deploy config, modelled on `checklist/website/deploy.conf`:

```
export DEPLOY_TYPES="letsencrypt apache"
export APP_NAME="rkr-blog-www"
export DOMAIN_NAME="rkr-blog-www.rkroll.com"
export REMOTE_HOST="rkr-blog-www.rkroll.com"
export REMOTE_USER="john"
export APACHE_MODE="static"
export APACHE_CONTENT_DIR="${PROJECT_DIR}"
export APACHE_BUILD_ENABLED="no"
export APACHE_WEB_ROOT="/var/www/rkr-blog-www"
export APACHE_CACHE_STATIC="yes"
export APACHE_SECURITY_HEADERS="yes"
export LETSENCRYPT_EMAIL="john@rkroll.com"
```

Deploys only the built artifacts (`*.html`, `*.svg`); `*.md` and
`build-legal.js` stay out of the web root (the siblings handle this the
same way).

## Out of scope / manual steps

- **DNS:** `rkr-blog-www.rkroll.com` must resolve to the VPS before its
  `deploy.sh init`. Assumed handled by the operator.
- **App CTA wiring** on the landing page — deferred until an app entry
  flow exists.
- The app and its deployment are untouched.

## Testing

- Static pages: open `website/index.html` locally; verify layout at mobile
  and desktop widths, nav toggle works, all feature cards render, footer
  links resolve to the legal pages, and each legal page renders with the
  shared chrome.

## Deploy sequence (runbook addition)

1. Ensure DNS for `rkr-blog-www.rkroll.com` points at the VPS.
2. `deploy.sh init website/` — provision the static landing vhost + cert.
3. Subsequent updates: `deploy.sh update website/`.
