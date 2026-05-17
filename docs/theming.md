# Theming contract

Themes are CSS stylesheets that target the HTML the rkroll templates
emit. A theme **never** edits templates or admin code — it only
overrides custom-property values and styles class hooks documented
below. This contract is what keeps a theme swap a one-file change.

When you port a theme (Hugo / Jekyll / Astro / classless framework)
into `static/themes/<name>.css`, your job is to map its design
decisions onto these hooks. If a theme needs something the contract
doesn't expose, raise it before adding ad-hoc classes — the contract
is meant to grow only when the templates genuinely need more
structure.

## Switching themes

Two ways to pick a theme, in precedence order (highest first):

1. **Persistent**: `<siteRoot>/config/site.json#theme`. The admin
   settings UI writes this; survives restarts and lives with the
   site's content.
2. **Env var**: `SITE_THEME=papermod node bin/server.js`. The
   fallback for deployments that don't run an admin UI.

The default theme (`static/themes/default.css`) is the full
structural stylesheet; alternate themes (`static/themes/<name>.css`)
layer on top of it and override only what they want to change. The
cascade order is:

1. `base.css` — a11y + overflow primitives.
2. `themes/default.css` — the framework: full structural CSS + the
   default look. Always loaded.
3. `themes/<active>.css` — the chosen theme's overrides. Skipped when
   the active theme IS `default`.

To add a theme, drop `<name>.css` into `static/themes/`. The file can
be small: redefine the custom-property surface, plus any rules that
need to differ. An unknown theme name falls back to `default` with a
one-shot stderr warning.

### Bundled themes

The repo seeds the picker with eight themes. Each is a single CSS
file layered on `default.css`:

| Name        | Feel                                                        |
| ----------- | ----------------------------------------------------------- |
| `default`   | Photo-friendly serif body, blue accent, light/dark.         |
| `papermod`  | Monochrome sans-serif, pill admin links (Hugo PaperMod).    |
| `tufte`     | Cream paper, italic display, wide left rail (Tufte CSS).    |
| `dracula`   | Vivid dark palette with cyan/green/pink accents.            |
| `terminal`  | Monospace throughout, phosphor green on black.              |
| `solarized` | Solarized cream + slate, with the `light`/`dark` palette.   |
| `mvp`       | Classless-CSS-framework feel, centred masthead, soft cards. |
| `newsprint` | Newspaper masthead, double rules, drop caps, ink red.       |

## HTML invariants

Themes can assume this structure on every public page:

```html
<a class="rkr-skip" href="#main">…</a>
<header class="rkr-site-head">
  <div class="rkr-site-head-inner">
    <p class="rkr-site-title"><a href="/">…</a></p>
    <span class="rkr-site-tagline">…</span>          <!-- optional -->
  </div>
  <nav class="rkr-admin-strip" aria-label="Admin">  <!-- when logged in -->
    <a class="rkr-admin-strip-link" href="/admin/editor">New post</a>
    <a class="rkr-admin-strip-link" href="/admin/posts">Posts</a>
    <a class="rkr-admin-strip-link" href="…">Edit this post</a>  <!-- on /:slug -->
    <form class="rkr-admin-strip-logout" method="post" action="/admin/logout">
      <button class="rkr-admin-strip-link">Logout</button>
    </form>
  </nav>
</header>
<main id="main" tabindex="-1">…</main>
<footer class="rkr-site-foot">
  &copy; … <span class="rkr-site-foot-sep">·</span>
  <a class="rkr-site-foot-admin" href="/admin/login">Admin</a>
</footer>
```

Per surface:

- **Index** (`/`): `<main>` contains `<h1 class="rkr-index-heading">`
  (visually hidden by default; provides a document-level h1 for a11y)
  and a `<ul class="post-list">` of `<li>` entries with `<time>` +
  `<a>`. Pagination, when present, is `<nav aria-label="pagination">`.
- **Post** (`/:slug`): `<main>` contains `<article>` with `<header>`
  (`<h1>` + `<time>`) and the post body. Images render through
  `<figure class="rkr-figure …">` — see "Figure widget" below.
- **Admin posts** (`/admin/posts`, admin-only): `<table
  class="rkr-admin-posts">` with status pills
  (`.rkr-admin-posts-status.is-draft` / `.is-published`) and edit /
  delete buttons.
- **Login** (`/admin/login`): `<section class="rkr-login">` inside
  `<main>`. Contains the Google button + token form.

The editor (`/admin/editor`) has its own UI shell separate from this
contract; themes do **not** style the editor.

## CSS custom properties (themable)

Themes redefine these on `:root` (and optionally on `[data-theme="dark"]`
or under `@media (prefers-color-scheme: dark)`).

| Property            | Default                       | Used for                                   |
| ------------------- | ----------------------------- | ------------------------------------------ |
| `--rkr-bg`          | `#fdfdfb`                     | Page background.                           |
| `--rkr-text`        | `#1a1a1a`                     | Primary text colour.                       |
| `--rkr-muted`       | `#707070`                     | Captions, footers, admin strip text.       |
| `--rkr-rule`        | `#e5e5e2`                     | Borders, separators, code-block bg.        |
| `--rkr-link`        | `#1a4f7f`                     | Links, primary buttons, active states.     |
| `--rkr-link-hover`  | `#0d2c4d`                     | Link / primary-button hover.               |
| `--rkr-shadow`      | `rgba(0,0,0,0.08)`            | Drop shadows on cards / hover lifts.       |
| `--rkr-content`     | `64rem`                       | Outer column width (figures, galleries).   |
| `--rkr-prose`       | `38rem`                       | Inner column width for body prose.         |
| `--rkr-gap`         | `1.25rem`                     | Default vertical gap.                      |
| `--rkr-radius`      | `4px`                         | Border-radius for inputs / pills / cards.  |
| `--rkr-prose-font`  | `ui-serif, Georgia, …`        | Body-text font stack.                      |
| `--rkr-display-font`| `-apple-system, …`            | Headings, site title, post-list, dates.    |
| `--rkr-mono-font`   | `ui-monospace, …`             | Inline + block code.                       |
| `--rkr-base-size`   | `1.0625rem`                   | Root font size.                            |
| `--rkr-line-height` | `1.6`                         | Body line height.                          |

### Structural tokens

These shape the chrome layout without raw class overrides. Prefer setting
these over writing `.rkr-site-head { text-align: center }` in theme CSS.

| Property                  | Default                       | Controls                                            |
| ------------------------- | ----------------------------- | --------------------------------------------------- |
| `--rkr-head-border`       | `1px solid var(--rkr-rule)`   | `border-bottom` on `.rkr-site-head`.                |
| `--rkr-head-padding`      | `1.25rem 1.5rem 0.85rem`      | `padding` on `.rkr-site-head`.                      |
| `--rkr-header-direction`  | `row`                         | `flex-direction` on `.rkr-site-head-inner`.         |
| `--rkr-header-text-align` | `left`                        | `text-align` on `.rkr-site-head`.                   |
| `--rkr-foot-border`       | `1px solid var(--rkr-rule)`   | `border-top` on `.rkr-site-foot`.                   |
| `--rkr-title-size`        | `1.45rem`                     | Site title font size.                               |
| `--rkr-title-weight`      | `700`                         | Site title font weight.                             |
| `--rkr-title-style`       | `normal`                      | Site title font style.                              |
| `--rkr-title-transform`   | `none`                        | Site title `text-transform`.                        |
| `--rkr-title-tracking`    | `-0.01em`                     | Site title `letter-spacing`.                        |
| `--rkr-h1-size`           | `2rem`                        | Post article h1 font size.                          |
| `--rkr-h1-style`          | `normal`                      | Post article h1 font style.                         |
| `--rkr-h1-weight`         | `bold`                        | Post article h1 font weight.                        |
| `--rkr-h2-style`          | `normal`                      | Article h2/h3/h4 font style.                        |
| `--rkr-h2-weight`         | `bold`                        | Article h2/h3/h4 font weight.                       |
| `--rkr-list-cols`         | `1fr 8rem`                    | `grid-template-columns` on `.post-list li` (title \| fixed date col). |
| `--rkr-blockquote-border` | `3px solid var(--rkr-rule)`   | `border-left` on `article blockquote`.              |
| `--rkr-main-margin-left`  | `auto`                        | `margin-left` on `main` (use `8%` for left-biased). |
| `--rkr-main-pad`          | `1.25rem 1.5rem`              | `padding` on `main`.                                |
| `--rkr-figure-margin`     | `2rem`                        | Vertical `margin` on `.rkr-figure` (horizontal stays `auto`). |
| `--rkr-list-row-pad`      | `0.6rem`                      | Vertical `padding` on `.post-list li`.              |
| `--rkr-teaser-gap`        | `1.5rem`                      | `.rkr-teaser` `margin-bottom` + `padding-bottom`.   |

## Stable class hooks

A theme overrides any of the selectors below. The list is intended to
be exhaustive — new public-facing classes added to the templates
should be added here at the same time.

### Site chrome
- `.rkr-skip` — visually-hidden skip-to-content link (revealed on focus).
- `.rkr-site-head`, `.rkr-site-head-inner` — header band + centred inner column.
- `.rkr-site-title` — site title wordmark; child `a` for the home link.
- `.rkr-site-tagline` — optional tagline next to the title.
- `.rkr-admin-strip` — admin-only navigation bar inside the header.
- `.rkr-admin-strip-link` — every clickable in the strip (anchor or button).
- `.rkr-admin-strip-logout` — wrapping `<form>` for the logout POST.
- `.rkr-site-foot`, `.rkr-site-foot-sep`, `.rkr-site-foot-admin` — footer + dot separator + small admin link.

### Index
- `.rkr-index-heading` — visually-hidden h1 on `/`.
- `.post-list`, `.post-list li`, `.post-list time`, `.post-list a`.
- `nav[aria-label="pagination"]` — pager block.

### Post body (prose)
- `article` — body wrapper; max-width via `--rkr-prose`.
- `article > header h1` — post title.
- `article > header time` — published date.
- `article p`, `article blockquote`, `article ul/ol`, `article hr`,
  `article code`, `article pre` — body typography.

### Figure widget
The figure widget is the unified image element. Themes typically only
restyle the caption + frame; the layout machinery lives in shared
rules a theme should not touch.

- `.rkr-figure` — outer wrapper.
- `.rkr-figure > figcaption` — caption text.
- Layout-mode classes (do not redefine the geometry — only colour /
  border / spacing):
  - `.rkr-figure-grid` — fixed NxM grid.
  - `.rkr-figure-justified` — variable-row gallery.
  - `.rkr-figure-masonry` — column-major masonry.
  - `.rkr-carousel` — carousel mode.
- Cell wrappers: `.rkr-figure-cell`, `.rkr-figure-cell picture`,
  `.rkr-figure-cell img`.
- Fit classes: `.rkr-fit-cover`, `.rkr-fit-contain`.
- Justify classes: `.rkr-justify-center`, `.rkr-justify-left`,
  `.rkr-justify-right`, `.rkr-justify-full`, `.rkr-justify-bleed`.

### Admin posts list (`/admin/posts`)
- `.rkr-admin-posts-heading` — page h1.
- `.rkr-admin-posts` — the `<table>`.
- `.rkr-admin-posts-status` + `.is-draft` / `.is-published` — status pills.
- `.rkr-admin-posts-actions` — right-aligned action column.
- `.rkr-admin-posts-edit`, `.rkr-admin-posts-del`,
  `.rkr-admin-posts-del-btn` — per-row affordances.
- `.rkr-admin-posts-empty` — empty-state row.

### Login (`/admin/login`)
- `.rkr-login` — section wrapper.
- `.rkr-login-google` — Google sign-in anchor.
- `.rkr-login-form`, `.rkr-login-form label`, `.rkr-login-form input`,
  `.rkr-login-submit`, `.rkr-login-hint`.

## Light vs. dark scheme

The default theme is light. To ship a theme with both schemes,
either:

1. Set the dark variables under `@media (prefers-color-scheme: dark)`
   so the OS toggle drives them, **or**
2. Set them under `[data-theme="dark"]` and let the page (or a future
   user toggle) select.

Themes should not assume any particular toggle UI — the contract is
just the variable surface.

## What themes should NOT touch

- Templates (`src/templates/**`) — adding markup is a contract change.
- Editor shell (`/admin/editor`) — own UI, not part of the public
  surface.
- Service worker behaviour, build outputs, JS files.
- Figure widget geometry (grid / flow / carousel) — restyle the frame
  + cells, but don't alter layout maths.

## Reviewing a new theme

When you add a theme:

1. Diff its CSS against this contract: every selector it uses should
   either be in the table above, or be a default browser element
   (`a`, `h1`, `time`, etc.) that the contract permits.
2. Run the e2e suite with `SITE_THEME=<name>` set — at minimum the
   index, a post, and `/admin/login` should render without obvious
   breakage.
3. Smoke-test admin chrome (`/`, `/:slug`, `/admin/posts`) to confirm
   the admin strip + posts table still read.
4. Note any contract gaps in DEFERRED.md rather than papering them
   over with theme-local class names.
