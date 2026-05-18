# rkr-blog — Market Research

## Target Users

**Technical photographer.** Shoots seriously, maintains their own originals, and has watched cloud platforms quietly recompress masters, delete accounts, or deprecate APIs. Wants a system where the stored master is never touched after ingest, where crop and perspective corrections are stored as reversible JSON ops, and where derivative images are regenerated on demand — not baked into a copy that can't be undone. Comfortable with a VPS and Apache config; not a developer by trade. Trusts a single-purpose tool with a legible source tree over a plugin-heavy CMS they can't audit.

**Developer-photographer.** Builds things for a living, photographs as a serious side practice, and finds hosted platforms either too opaque or too limiting. Wants a stack they can read end-to-end: Node 22 + Fastify 5 + SQLite (`node:sqlite`, no ORM), Apache for static derivative serving — no Redis, no CDN dependency, no framework magic. Likely to fork, extend, or swap a component, and wants to do that without reverse-engineering a plugin API.

---

## Competitive Landscape

### 1. Hosted Blog Platforms (Ghost, micro.blog, Squarespace)

Run entirely in the cloud; the operator controls the data. Image editing is basic (crop, resize); no in-browser perspective correction or non-destructive sidecar pipelines. Strong editorial UI and managed hosting are the trade.

| Feature | Ghost | micro.blog | Squarespace | rkr-blog |
|---|---|---|---|---|
| Non-destructive editing | No | No | No | Yes (JSON sidecar ops) |
| Self-hosted | Optional (Ghost Pro is hosted; OSS self-host is complex) | No | No | Yes (only mode) |
| Image layout options | 1 (content width) | 1 | 2–3 templates | 6 layout modes |
| Offline editing | No | No | No | Yes |
| Stack complexity | Node + MySQL/SQLite + CDN | Hosted only | Hosted only | Node + SQLite + Apache |

rkr-blog trails on: zero onboarding friction, managed TLS/DNS, built-in email newsletter, multi-author workflow.

---

### 2. Self-Hosted CMS (WordPress, Kirby CMS, Statamic)

General-purpose content systems that support photography via plugins or themes. WordPress has the widest ecosystem; Kirby and Statamic target developers who want flat-file or structured-content workflows. All three can handle a photo blog, but none treat image editing as a first-class primitive.

| Feature | WordPress | Kirby CMS | Statamic | rkr-blog |
|---|---|---|---|---|
| Non-destructive editing | No (Media Library bakes edits) | No | No | Yes |
| Self-hosted | Yes | Yes | Yes | Yes |
| Image layout options | Plugin-dependent | Theme-dependent | Theme-dependent | 6 built-in |
| Offline editing | No | No | No | Yes (OPFS outbox) |
| Stack complexity | PHP + MySQL + plugin sprawl | PHP + flat files | PHP + flat files or MySQL | Node + SQLite + Apache |

rkr-blog trails on: plugin ecosystem, theme marketplace, multi-author, mobile apps, e-commerce integration.

---

### 3. Static Site Generators with CMS Layer (Hugo, Astro + Decap, Jekyll)

Build-time systems: content is committed to git, a generator produces HTML, a CDN serves it. Fast and cheap to host; the editorial experience via Decap/Netlify CMS is mediocre. No server-side image pipeline means you either check in pre-processed derivatives or bolt on a CDN image transform service. No dynamic features (comments, live-preview drafts, offline admin) without a separate service.

| Feature | Hugo + Decap | Astro + Decap | Jekyll | rkr-blog |
|---|---|---|---|---|
| Non-destructive editing | No | No | No | Yes |
| Self-hosted | Yes (build + static hosting) | Yes | Yes | Yes (VPS) |
| Image layout options | Theme-dependent | Component-dependent | Theme-dependent | 6 built-in |
| Offline editing | No | No | No | Yes |
| Dynamic features (comments, drafts) | Requires external service | Requires external service | Requires external service | Built-in |

rkr-blog trails on: zero server cost (static CDN hosting), git-native content history, no SQLite/server maintenance burden.

---

### 4. Photo-Specific Tools (Piwigo, Lychee, Zenphoto)

Gallery and album systems designed for photography, not prose. Strong at organizing large image libraries with metadata, tags, and albums. Weak at editorial content (posts, prose), in-browser editing, and derivative management beyond thumbnails. Piwigo is the most mature, with a plugin ecosystem and GDPR tooling.

| Feature | Piwigo | Lychee | Zenphoto | rkr-blog |
|---|---|---|---|---|
| Non-destructive editing | No | No | No | Yes |
| Self-hosted | Yes | Yes | Yes | Yes |
| Editorial content (prose posts) | Minimal | No | Limited | Yes |
| Image layout options | Album grid only | Grid / Justified | Grid / Album | 6 layout modes |
| Offline editing | No | No | No | Yes |

rkr-blog trails on: large-library management, EXIF/metadata browsing, public album sharing without posts, plugin marketplace.

---

## Where rkr-blog Wins

- **WebGL perspective rectify in the browser.** 4-corner drag with inverse homography shader; result stored as a reversible JSON op. No other self-hosted blog platform has this.
- **True non-destructive pipeline.** The stored master is never written after ingest. Every edit — crop, rotate, flip, resample, perspective — is a JSON op in a sidecar. Any op can be removed to recover the original framing; derivatives are regenerated on demand.
- **Six layout modes from one editor block.** Justified rows (Flickr-style), masonry columns, NxM grid, carousel (manual + autoplay), full-bleed, inline — no theme or plugin required.
- **Apache serves derivatives directly.** Cache hits bypass Node entirely. Derivatives are 6 widths × 3 formats (WebP, AVIF, JPEG). Node handles only misses.
- **Offline admin.** Draft, edit, and queue saves while offline; changes sync automatically when connectivity returns.
- **Ingest-time WebP encode with generation-loss awareness.** PNG → lossless WebP; others → lossy WebP. The WordPress importer uses passthrough mode to avoid re-encoding already-compressed files.
- **Ollama-backed comment spam classification.** Local inference; no third-party moderation SaaS. New comments trigger email notification to the site owner via SMTP.
- **Full-text search.** Built-in FTS across all published posts; no external search service required.
- **Tags with autocomplete.** Posts can be tagged in the editor with autocomplete; the index filters by tag.
- **Minimal, auditable stack.** Node 22 + Fastify 5 + SQLite + Sharp + Apache. A developer can read the entire system in a few sessions.

---

## Where rkr-blog Trails

- **No multi-author workflow.** User management is CLI-only; no UI for inviting or managing co-authors beyond the allowlist.
- **No plugin or theme marketplace.** 8 CSS-only themes ship out of the box; extending requires writing code.
- **No managed hosting.** Requires a VPS or container host (Fly.io supported); no one-click cloud deploy or managed SaaS option.
- **No mobile app.** Admin is a web app; no native iOS or Android client.
- **No CDN integration.** Apache serves derivatives from disk; no built-in Cloudflare, Fastly, or S3 offload path.
- **Corpus scan performance.** `listPosts` and `listSidecars` do full scans; performance degrades with very large image libraries.
- **Single-instance only.** In-process semaphores mean horizontal scaling requires architectural changes.

---

## Positioning Summary

rkr-blog is for the single-author photographer who wants full, auditable control over image storage, editing, and serving — and is willing to run a VPS to get it. It occupies a niche that hosted platforms and gallery tools both miss: a proper editorial blog (prose, layout, drafts, comments) with a non-destructive image pipeline and in-browser editing tools sophisticated enough to replace a desktop adjustment step. It is not a general-purpose CMS, not a multi-user platform, and not trying to be.
