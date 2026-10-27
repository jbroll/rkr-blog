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
    <div class="rkr-site-head-brand">
      <p class="rkr-site-title"><a href="/">…</a></p>
      <span class="rkr-site-tagline">…</span>        <!-- optional -->
    </div>
    <nav class="rkr-site-head-nav" aria-label="Site">
      <a class="rkr-site-head-auth-btn" href="/">Home</a>   <!-- omitted on / -->
      <a class="rkr-site-head-auth-btn" href="/about">About</a>
      <div class="rkr-site-head-auth">
        <a class="rkr-site-head-auth-btn" href="/login">Login</a>      <!-- anonymous -->
        <form class="rkr-site-head-auth-form" method="post" action="/admin/logout">
          <button class="rkr-site-head-auth-btn">Logout</button>     <!-- logged in -->
        </form>
      </div>
    </nav>
  </div>
</header>
<main id="main" tabindex="-1">…</main>
<footer class="rkr-site-foot">
  &copy; …
  <a class="rkr-site-foot-admin" href="/login">Admin</a>
</footer>
```

When a `_footer` block page is published, its rendered blocks replace the
copyright line inside `.rkr-site-foot`. The admin link follows in both cases:
`/login` when signed out, `/admin/blocks` when signed in.

When `site.json#menu` is set, the header is built from the settings
instead (see `docs/spec.md` §14a), with the announcement bar above it
when one is on:

```html
<div class="rkr-announce" data-rkr-announce="…">
  <p class="rkr-announce-text">…</p>                  <!-- text or a link -->
  <button class="rkr-announce-close" hidden>×</button> <!-- shown by JS -->
</div>
<a class="rkr-skip" href="#main">…</a>
<header class="rkr-site-head has-menu">
  <div class="rkr-site-head-inner">
    <div class="rkr-site-head-brand">
      <p class="rkr-site-title"><a href="/">…</a></p>  <!-- logo <picture> or title -->
      <span class="rkr-site-tagline">…</span>          <!-- optional -->
    </div>
    <span class="rkr-site-head-version">…</span>       <!-- build hash, public pages -->
    <input type="checkbox" id="rkr-menu-toggle" class="rkr-menu-toggle"/>
    <label for="rkr-menu-toggle" class="rkr-menu-toggle-btn">…Menu</label>
    <nav class="rkr-site-head-nav rkr-site-menu" aria-label="Site">
      <ul class="rkr-site-menu-list"><li><a class="rkr-site-menu-link">…</a></li></ul>
      <a class="rkr-btn rkr-site-head-cta">…</a>        <!-- optional -->
      <ul class="rkr-site-social"><li><a aria-label="…"><svg/></a></li></ul>
      <div class="rkr-site-head-auth">…Logout…</div>  <!-- signed-in admin -->
    </nav>
  </div>
</header>
```

The menu folds at `48rem`. Under it the toggle label shows and
`.rkr-site-menu` is hidden until the checkbox is checked. To fold at
another width, a theme writes its own `@media` rules for the same
classes. A wider fold repeats the rules of default.css's
`@media (max-width: 48rem)` block under the new width; a narrower one
also restores the open menu, and hides the toggle, between the new
width and `48rem`.

Per surface:

- **Index** (`/`): `<main>` contains `<h1 class="rkr-index-heading">`
  (visually hidden by default; provides a document-level h1 for a11y)
  and a `<ul class="post-list">` of `<li>` entries with `<time>` +
  `<a>`. Pagination, when present, is `<nav aria-label="pagination">`.
- **Post** (`/:slug`): `<main>` contains `<article>` with `<header>`
  (`<h1>` + `<time>` + `<a class="rkr-comment-bubble" href="#respond">`)
  and the post body. Images render through
  `<figure class="rkr-figure …">` — see "Figure widget" below. After
  the article: `<section class="rkr-comments" id="comments">` and
  `<section class="rkr-comment-form-wrap" id="respond">`.
- **About** (`/about`): the post surface without the bubble or the
  comment sections.
- **Search** (`/search`): the index layout with a `.post-list
  rkr-search-results` list; each `<li>` adds `<p
  class="rkr-search-snippet">` containing `<mark>` spans.
- **Admin posts** (`/admin/posts`, admin-only): `<table
  class="rkr-admin-posts">` with status pills
  (`.rkr-admin-posts-status.is-draft` / `.is-published`) and edit /
  delete buttons.
- **Login** (`/admin/login`): `<section class="rkr-login">` inside
  `<main>`. Contains the Google button + token form.

The block editor (`/admin/blocks/edit/:slug`) has its own UI shell separate from this
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
| `--rkr-logo-height`       | `3rem`                        | Height of the header logo image.                    |
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
- `.rkr-site-head-brand` — title + tagline group.
- `.rkr-site-title` — site title wordmark; child `a` for the home link.
- `.rkr-site-tagline` — optional tagline next to the title.
- `.rkr-site-head-nav` — the Home / About / Login|Logout group. Layout
  lives in `base.css`; colour comes from `.rkr-site-head-auth-btn`.
- `.rkr-site-head-auth-btn` — every clickable in the nav (anchor or button).
- `.rkr-site-head-auth`, `.rkr-site-head-auth-form` — login/logout slot
  and the logout POST form.
- `.rkr-site-head.has-menu` — the header built from `site.json#menu`.
- `.rkr-site-menu`, `.rkr-site-menu-list`, `.rkr-site-menu-link` — its
  nav, link list and links.
- `.rkr-menu-toggle`, `.rkr-menu-toggle-btn`, `.rkr-menu-toggle-bars` —
  the no-JS phone toggle (checkbox, its label, the three-bar glyph).
- `.rkr-site-head-cta` — the header button (also `.rkr-btn`).
- `.rkr-site-social` — the social icon list.
- `.rkr-announce`, `.rkr-announce-text`, `.rkr-announce-close` — the
  announcement bar above the header.
- `.rkr-fab` — the admin floating action buttons (edit, new post,
  settings, comments) shown bottom-right when logged in.
- `.rkr-site-foot`, `.rkr-site-foot-admin` — footer + small admin link.

### Index
- `.rkr-index-heading` — visually-hidden h1 on `/`.
- `.post-list`, `.post-list li`, `.post-list time`, `.post-list a`.
- `nav[aria-label="pagination"]` — pager block.
- `.rkr-tag-rail`, `.rkr-rail-controls` — right-hand rail and its
  sort + search row.
- `.rkr-sort-toggle`, `.rkr-site-search`, `.rkr-site-search input` —
  the two rail controls.
- `.rkr-search-results`, `.rkr-search-snippet`, `.rkr-search-empty` —
  search page additions; `mark` inside a snippet is the match.

### Comments
- `.rkr-comment-bubble`, `.rkr-comment-bubble-count` — header
  count-and-jump anchor. Absolutely positioned in `default.css`; the
  post `<header>` is its containing block.
- `.rkr-comments`, `.rkr-comment-list`, `.rkr-comment`,
  `.rkr-comment-meta`, `.rkr-comment-body`, `.rkr-comment-replies`,
  `.rkr-comments-empty` — the list.
- `.rkr-comment-form-wrap`, `.rkr-comment-form`, `.rkr-cf-name`,
  `.rkr-cf-email`, `.rkr-cf-comment`, `.rkr-cf-submit`,
  `.rkr-comment-notice` — the form. Grid layout is in `base.css`.
- `.rkr-hp` — the honeypot wrapper. Never restyle it: its `base.css`
  rule is what keeps the decoy field invisible, and a theme that shows
  it silently drops real comments.

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
- Mask classes, set by the `mask` attribute on the figure and applied to
  every cell: `.rkr-mask-circle` (square crop, 50% radius) and
  `.rkr-mask-rounded`, whose corner radius is `--rkr-mask-radius`
  (default `1.5rem`). A theme sets the variable to reshape rounded
  images.
- With `href` set, each cell's `<picture>` sits in a plain `<a>` and
  carries no `data-pswp-*` attributes, so the lightbox ignores it.

### Video widget
The `::video` widget is the self-hosted video element. It shares the
figure widget's `.rkr-justify-*` placement classes. Themes typically
only restyle the frame + caption; the layout machinery lives in shared
rules a theme should not touch.

- `.rkr-video` — outer wrapper.
- `.rkr-video-wrapper` — aspect-reserving frame around the player
  (`aspect-ratio: var(--rkr-video-aspect, 16/9)`; the widget sets
  `--rkr-video-aspect` inline from the source dimensions).
- `.rkr-video-wrapper video` — the player element.
- `.rkr-video-caption` — caption text.

### Blocks

Block pages (spec §8a) render through these classes.

- `.rkr-section` — a band (`grid` with `band: true`). Its background
  spans the viewport; padding is `--rkr-section-pad`. A band inside a
  `.rkr-grid-cell` stays in the cell. A waved band that is last in its
  container gets a bottom margin of `--rkr-section-wave-height`.
- `.rkr-theme-<name>` — on `.rkr-section`, the band's section theme.
  Sets `--rkr-band-bg`, `--rkr-band-fg`, `--rkr-band-heading` and
  `--rkr-band-link` from the `--rkr-section-<name>-*` tokens; the band
  reads those four for its background, text, headings and links.
- `.has-bg` — on `.rkr-section` when it has a background image.
- `.rkr-section-bg` — the background image layer: a `<picture>` that
  covers the band, under the content. Decorative (`aria-hidden`).
- `.rkr-section-inner` — the band's grid, capped at `--rkr-content`
  and centered. With column widths the cap is on the `.rkr-grid-wrap`
  that holds it.
- `.rkr-section-wave` — a wave of height `--rkr-section-wave-height` in
  the band's background color, hung below the band over the top of the
  next one. Only with `edge: wave`.
- `.rkr-grid` — every grid. `--rkr-grid-cols`, `--rkr-grid-min` and
  `--rkr-grid-widths` are set inline from the slots; don't override
  them.
- `.rkr-grid-wrap` — wraps a grid with column widths so it can collapse
  on its own width.
- `.rkr-grid-cell` — one child of a grid.
- `.rkr-align-center` — on `.rkr-grid` with `align: center`: centered
  text and cells.
- `.rkr-box` — on `.rkr-grid` with `box: true`: a panel with
  `--rkr-box-bg`, `--rkr-box-fg`, `--rkr-box-pad` and `--rkr-radius`.
- `.rkr-btn` with `.is-primary` or `.is-secondary` — button block.
- `.rkr-marquee` (text in a `span`) — scrolling text.
- `.rkr-accordion` — `details` items.
- `.rkr-progress`, `.rkr-progress-bar` — progress bar.
- `.rkr-embed` — embedded iframe.
- `.rkr-macro-<name>` — see Macros below.

| Token | Default | Used for |
| --- | --- | --- |
| `--rkr-section-pad` | `3rem 1.5rem` | `padding` on `.rkr-section`. |
| `--rkr-section-wave-height` | `1.5rem` | Height of `.rkr-section-wave`. |
| `--rkr-section-light-bg` | `--rkr-bg` mixed 6% toward `--rkr-text` | `light` band background. |
| `--rkr-section-light-fg`, `-heading` | `var(--rkr-text)` | `light` band text and headings. |
| `--rkr-section-light-link` | `var(--rkr-link)` | `light` band links. |
| `--rkr-section-light-bold-bg` | `#f6d776` | `light-bold` band background. |
| `--rkr-section-light-bold-fg`, `-heading` | `#1a1a1a` | `light-bold` band text and headings. |
| `--rkr-section-light-bold-link` | `#5a2d0c` | `light-bold` band links. |
| `--rkr-section-dark-bg` | `#2a2438` | `dark` band background. |
| `--rkr-section-dark-fg` | `#f5f2ea` | `dark` band text. |
| `--rkr-section-dark-heading` | `#ffffff` | `dark` band headings. |
| `--rkr-section-dark-link` | `#f5f2ea` | `dark` band links. |
| `--rkr-section-dark-bold-bg` | `#1a4f7f` | `dark-bold` band background. |
| `--rkr-section-dark-bold-fg`, `-heading` | `#ffffff` | `dark-bold` band text and headings. |
| `--rkr-section-dark-bold-link` | `#ffe8a3` | `dark-bold` band links. |
| `--rkr-box-bg` | `var(--rkr-bg)` | `.rkr-box` background. |
| `--rkr-box-fg` | `var(--rkr-text)` | `.rkr-box` text. |
| `--rkr-box-pad` | `1.5rem` | `.rkr-box` padding. |

A theme restyles the four built-in section themes by setting their
tokens. To add a section theme, declare its name in one comment line
the server reads, then define its tokens and map them:

```css
/* rkr-section-themes: forest, sand */
:root {
  --rkr-section-forest-bg: #1f3d2b;
  --rkr-section-forest-fg: #f1efe8;
  --rkr-section-forest-heading: #ffffff;
  --rkr-section-forest-link: #cde8b5;
}
.rkr-theme-forest {
  --rkr-band-bg: var(--rkr-section-forest-bg);
  --rkr-band-fg: var(--rkr-section-forest-fg);
  --rkr-band-heading: var(--rkr-section-forest-heading);
  --rkr-band-link: var(--rkr-section-forest-link);
}
```

Names match `[a-z-]+`. The section themes offered for a band are
`light`, `light-bold`, `dark`, `dark-bold`, then the active theme's
declared names (`activeSectionThemes()` in `src/lib/themes.ts`).

### Macros
- `.rkr-macro-<name>` — root element of every instance of the macro
  `macros/<name>.json`: the band's `<section>`, the outermost grid
  element, or a `div` wrapping a leaf root. Scope a macro's styles with
  it, such as `.rkr-macro-board .rkr-grid-cell`. Names outside
  `[a-z][a-z0-9-]*` get no class.

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
- Editor shell (`/admin/blocks/edit/:slug`) — own UI, not part of the public
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
