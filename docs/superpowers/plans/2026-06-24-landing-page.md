# rkr-blog landing page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship a static marketing landing page for rkr-blog at `rkr-blog-www.rkroll.com`, matching the rkroll family of sibling sites.

**Architecture:** A new top-level `website/` directory holding hand-authored static HTML (Tailwind via CDN, no build step), a copied app icon, and a static-mode `deploy.conf`. No app changes.

**Tech Stack:** Static HTML + Tailwind CDN. No new npm dependencies.

## Global Constraints

- **Palette:** crimson accent `#cf222e` (hover `#a40e26`), warm paper page bg `#fdfdfb`, card bg `#ffffff`, secondary surface `#ebeae4`, ink text `#1f2328`, muted `#5b6573`, border `#e2e1db`. Footer dark `#1f2328`.
- **No app CTA** anywhere (no "Try Free" / "Open App" buttons or links to the app).
- **Tailwind via CDN only** — `<script src="https://cdn.tailwindcss.com"></script>`. No build, no bundler.
- **Gauntlet-safe:** keep everything under `website/`. biome/tsc/knip use allowlist includes that exclude `website/`, so do NOT add `.ts`/build `.js`/npm deps. Pure `.html`, `.png`, `.conf` only.
- **eof gate:** every file ends with exactly one trailing newline, no trailing whitespace per line.
- Copy: brand name "rkr-blog"; owner site "rkroll.com" (Schenectady, New York); contact `john@rkroll.com`.

---

### Task 1: Scaffold `website/` — icon + deploy.conf

**Files:**
- Create: `website/rkr-blog-icon.png` (copy of `static/icon-192.png`)
- Create: `website/deploy.conf`
- Create: `website/README.md`

- [ ] **Step 1: Copy the app icon**

```bash
mkdir -p website
cp static/icon-192.png website/rkr-blog-icon.png
```

- [ ] **Step 2: Write `website/deploy.conf`**

```bash
#!/bin/bash
# deploy.conf — rkr-blog marketing site (rkr-blog-www.rkroll.com)
# Static landing page. The app itself is a SEPARATE deploy (../deploy.conf,
# rkr-blog.rkroll.com) and is untouched by this.
#
# Usage:
#   deploy.sh init   website/   # first deploy: SSL cert + Apache vhost
#   deploy.sh update website/   # subsequent: copy static files only

export DEPLOY_TYPES="letsencrypt apache"

export APP_NAME="rkr-blog-www"
export DOMAIN_NAME="rkr-blog-www.rkroll.com"
export REMOTE_HOST="rkr-blog-www.rkroll.com"
export REMOTE_USER="john"

# --- Apache (static mode: no build, no proxy) -------------------------------
export APACHE_MODE="static"
export APACHE_CONTENT_DIR="${PROJECT_DIR}"
export APACHE_BUILD_ENABLED="no"
export APACHE_WEB_ROOT="/var/www/rkr-blog-www"
export APACHE_CACHE_STATIC="yes"
export APACHE_SECURITY_HEADERS="yes"

# --- Let's Encrypt ----------------------------------------------------------
export LETSENCRYPT_EMAIL="john@rkroll.com"
```

- [ ] **Step 3: Write `website/README.md`** — one short paragraph: what this dir is (static marketing site), how to preview (`open website/index.html`), how to deploy (`deploy.sh init website/` then `update`), and that legal pages are hand-edited HTML.

- [ ] **Step 4: Verify**

```bash
test -f website/rkr-blog-icon.png && grep -q 'rkr-blog-www.rkroll.com' website/deploy.conf && echo OK
```
Expected: `OK`

- [ ] **Step 5: Commit** — `feat(website): scaffold rkr-blog marketing site (icon + static deploy.conf)`

---

### Task 2: `website/index.html` — hero + 8-feature grid

**Files:**
- Create: `website/index.html`

**Interfaces:**
- Produces: anchor targets and the nav/footer chrome that the legal pages (Task 3) copy verbatim. Footer links: `about.html`, `privacy.html`, `terms.html`.

Structure (single file, inline `:root` CSS-variable palette per Global Constraints):

- `<head>`: charset, viewport, `meta description` ("Photo-first, offline-first blogging you can self-host."), `<title>rkr-blog</title>`, `<link rel="icon" href="rkr-blog-icon.png">`, Tailwind CDN, `<style>` with the palette variables + `.feature-card`, `.btn`, `.illustration-*` helpers (adapt from checklist, recolor to crimson/paper).
- **Nav** (sticky, white): icon `rkr-blog-icon.png` (h-10) + wordmark "rkr-blog"; right side a single `About` link → `about.html`. Mobile hamburger toggling a stacked menu (copy the siblings' 3-line toggle script). No app CTA.
- **Hero** (warm-paper band): small "Self-hosted" pill, `<h1>` "Photo-first blogging, offline-first", one-line subhead drawn from README ("Bring in photos from anywhere, arrange them in rich layouts, publish — no markup, no plugins, no external services."). No CTA button.
- **Feature grid** (`grid md:grid-cols-2 lg:grid-cols-3 gap-4`), 8 cards, each = icon tile + title + one-line blurb + a small inline-SVG mini-illustration in a tinted `.illustration-area`. Content = the 8 features from the spec (photo-first import; six layouts; non-destructive editing; works offline; reader comments; fast by default; search·tags·themes; self-hosted).
- **Footer** (dark `#1f2328`): `© 2026 rkroll.com` + links to `about.html` / `privacy.html` / `terms.html`. No app CTA.
- Trailing `setTheme` console-hook `<script>` (optional, matches siblings) — keep only if it stays light by default.

- [ ] **Step 1: Write `website/index.html`** per the structure above.
- [ ] **Step 2: Verify structure**

```bash
grep -c 'feature-card' website/index.html   # expect >= 8
grep -q 'rkr-blog.rkroll.com' website/index.html && echo "FAIL: app link present" || echo "no app link OK"
grep -Eq 'Try Free|Open App' website/index.html && echo "FAIL: CTA present" || echo "no CTA OK"
```
Expected: count ≥ 8, "no app link OK", "no CTA OK".

- [ ] **Step 3: Render check** — open in a real browser (Playwright MCP): load `file://…/website/index.html`, screenshot desktop (1280) and mobile (390) widths, confirm grid renders, nav toggle works, no console errors.
- [ ] **Step 4: Commit** — `feat(website): rkr-blog landing page (hero + feature grid)`

---

### Task 3: Legal pages — about / privacy / terms

**Files:**
- Create: `website/about.html`
- Create: `website/privacy.html`
- Create: `website/terms.html`

**Interfaces:**
- Consumes: the nav + footer chrome and `<style>` block from `index.html` (copy verbatim, drop the hero/grid; swap content for a `max-w-4xl` white `.prose` card).

Content requirements:
- **about.html** — what rkr-blog is (1–2 short paragraphs from the README), "By rkroll.com — Schenectady, New York", contact `john@rkroll.com`, links to Privacy/Terms.
- **privacy.html** — must state actual data handling: reader comments are collected and stored; authors sign in via Google OAuth (email collected); the owner receives email notifications of new comments; an optional, configurable LLM may process comment text for spam filtering; self-hosted so data lives on the operator's own server; no third-party analytics/ad trackers. Contact `john@rkroll.com`.
- **terms.html** — short plain-language terms: provided as-is, no warranty; acceptable-use for comments; the operator runs the instance; contact `john@rkroll.com`.

Each page: same `<head>` palette/style + nav (with a `Home` link back to `index.html`) + `.prose` content card + footer.

- [ ] **Step 1: Write the three HTML files** sharing index's chrome.
- [ ] **Step 2: Verify**

```bash
for f in about privacy terms; do grep -q '.prose' website/$f.html && grep -q 'rkr-blog-icon.png' website/$f.html && echo "$f OK"; done
grep -qi 'comment' website/privacy.html && grep -qi 'oauth\|google' website/privacy.html && echo "privacy content OK"
```
Expected: three `OK` lines + "privacy content OK".

- [ ] **Step 3: Render check** — open each legal page in the browser; confirm shared chrome + readable prose, footer cross-links resolve.
- [ ] **Step 4: Commit** — `feat(website): about/privacy/terms legal pages`

---

### Task 4: Final review + deferred note

- [ ] **Step 1:** Add a one-line item to `docs/DEFERRED.md` under a Website area: app CTA wiring on the landing page — `_revisit when:_ the app gains a public entry/sign-up flow`.
- [ ] **Step 2:** Whole-dir gauntlet sanity: `npm run lint`-equivalent is irrelevant to `website/` (excluded), but run the pre-commit hook on the staged set to confirm green.
- [ ] **Step 3:** Self-review the rendered pages (clarity, no stray placeholder copy, no app links), fix inline, amend the relevant commit if trivial.
- [ ] **Step 4: Commit** the DEFERRED.md note — `docs(deferred): note landing-page app CTA wiring`.

## Deviations from spec

- Spec component #2 originally called for a `build-legal.js` md→html generator (sibling pattern). Dropped: `marked` is not installed and a standalone build `.js` under `website/` would be flagged by the `knip` gate. Legal pages are hand-authored static HTML instead (single brand, 3 short pages — simpler, gauntlet-safe). Spec updated to match.

## Self-review

- **Coverage:** index (Task 2), legal pages (Task 3), deploy.conf (Task 1), no-CTA constraint (Task 2 verify), DNS/manual steps are out-of-scope per spec. ✔
- **No new deps / gauntlet-safe:** all artifacts under `website/`, no `.ts`/build-`.js`. ✔
- **Palette consistency:** single Global Constraints block; index defines `<style>`, legal pages copy it. ✔
