# Organizational sites: what the ECCG trial port needs

Status: design, not built. Written 2026-10-27 after a trial port of six pages of the Electric City Community Grocery site (`eccg.coop`, which redirects to `electriccityfood.coop`, Squarespace 7.1) onto rkr-blog.

## Why

Two goals. Move the co-op's site off Squarespace, and use it to find what rkr-blog needs to run a real organizational site rather than a blog. The trial port built Home, About, Join, Contribute, News and one recipe page from block pages, site-local macros and a theme, with no `src/` changes. It matched the palette, wave bands, circle photos and card grids closely, and turned up 21 gaps. The one bug among them (images in macro slots never rendered) is fixed in `f438157`. This spec covers the rest.

[proposal-page-design.md](../../proposal-page-design.md) predates the block editor. Its directive syntax (`:::section`, `::list`) is obsolete: pages are JSON block trees and sections are `grid` nodes with `band: true`. Grid bands, buttons, marquee, accordion, progress and embed blocks already exist. Where this spec and the proposal differ, this spec wins. Its inventory, content counts, palette and "found during the inventory" list still hold.

## Goals

- A co-op editor can build every section the trial found from the palette, with no theme-name tricks and no hand-edited JSON.
- A site can be pages first: a chosen home page, pages with no date or comments, a configured menu and footer.
- Theme CSS styles blocks through documented classes and tokens, never through inline-style selectors or theme-name suffixes.

## Non-goals

- Commerce (memberships, merch, sponsorship checkout).
- Squarespace Fluid Engine's free positioning. Pages stay on the grid.
- The curved marquee, hand-drawn heading swashes, and the "new-spirit" and "adonis-web" fonts. System serif stacks stand, as decided 2026-10-22.
- Static publishing. That is [proposal-static-publishing.md](../../proposal-static-publishing.md). Nothing here may depend on a server at read time beyond what the current public routes already do.

## Anti-goals

- A non-technical editor can break the layout, for example by typing a class name or a raw color.
- Per-site code: everything the co-op needs ships as general features, macros or theme CSS.
- Theme CSS that depends on inline `style` attribute contents or on naming conventions in theme names. The trial's `eccg.css` does both (lines 152-212) and is the counter-example.

## Acceptance

The trial lives in `~/src/eccg-site`, a private repo kept out of rkr-blog because it holds the co-op's photos and text. Its README covers running it. `port/REPORT.md` lists the 21 gaps this spec numbers. `survey/` holds the live site's screenshots, the baseline for comparison, and `tools/build-pages.mjs` rebuilds the pages through the admin API.

Rebuild the six trial pages with the finished features, using the seed macros from part 7 and the theme loaded from the site root. `themes/eccg.css` then holds no `WORKAROUND` blocks, no `[style*=…]` or `[class*="-photo"]`/`[class*="-cards"]` selectors, and does not hide `.rkr-site-foot`, the article header or the comment form. Photos sit inside macros. The side-by-side screenshots at 1440px and 390px, made with `tools/shoot.mjs` and `tools/sheet.py`, are no further from the original than the trial's in `port/`, judged by eye.

## Parts, in build order

### 1. Pages that are not posts

Trial gaps 3 and 4. Every block page today gets an h1 header, a date, a copy-link button, a comment bubble and form, a row on `/`, and a place in search. `/` is always the post index and `about` is a reserved slug served from `_about.md`.

- **Kind field.** `fields.kind` is `post` (the default when absent) or `page`. The page settings dialog gets a Kind select.
- **A page** renders no article header (title, date, copy-link, comment bubble), no comments and no comment form, and is left out of the `/` list, the tag rail and any feed. The title still sets `<title>`. Pages stay in search. The `posts` table gets a `kind` column through a migration, filled by the indexer from `fields.kind`.
- **Home page.** `site.json#homePage` holds a page slug. When it is set, `/` renders that page. The post index is always also served at `/posts`, which joins the reserved slugs. When `homePage` is unset or names a missing page, `/` stays the post index. The settings page gets a Home page select listing pages of kind `page`.
  - With `homePage` set, everyone at `/` sees the home page, signed in or not. The admin post list, the tag rail's `?tag=` links, the `?sort=` toggle and the post-action 303 redirects all use `/posts`. The index links to its own path rather than a literal `/`. (Builder's call: find every hard-coded `/` that means "the index".)
  - The chosen page's own URL, `/<slug>`, 301s to `/`.
  - Adding `posts` to the reserved slugs blocks new pages only. If an existing post already has the slug `posts`, reindex logs a warning and `/posts` serves the index.
- **About.** `about` leaves the reserved list. `GET /about` serves a block page with slug `about` when one exists, and falls back to `_about.md` otherwise. This closes the `/about` half of the DEFERRED item on system pages.
- **Existing sites are unaffected.** No `kind` means `post` and no `homePage` means the current `/`.

### 2. Macros that can repeat and stay quiet

Trial gaps 7, 8 and 9. The trial copied the 13-person board grid, the 4×2 icon grid and the logo wall by hand because a macro has no list slot. Empty labels rendered empty pills. Theme CSS could not tell one macro's output from another's.

- **Empty leaves render nothing on the public page.** A button with an empty label renders nothing, as blank text and an id-less figure already do. The editor keeps its placeholder so the block stays selectable.
- **List slots.** A new fieldSchema type `list` with `item: Record<string, FieldSpec>` (the existing field types, not nested lists). Its value is an array of records. In the macro tree, a grid with `slots.each: "<list slot name>"` renders its children once per item. Inside it, `{{name}}` resolves from the item first and from the instance's slots second. The `each` grid counts as one grid level. `collectBlockFigureIds` expands `each` the same way the renderer does, so image fields in items resolve.
- **The macro dialog** shows a list field as a group of item rows with add, remove and move up/down. Each row uses the item's field specs, so an image field in a row opens the image picker as it does today.
- **Class hook.** A macro instance's root element carries `rkr-macro-<name>`. When the root is a leaf, the renderer wraps it in a `div` that carries the class. Authors never type class names.
- **Save validation:** a list value must be an array of records whose keys appear in `item`. Unknown keys are refused with the item index in the message.

### 3. Sections that can carry a site's look

Trial gaps 5, 6, 10, 11, 12 and 13.

- **Full-bleed bands.** A band's background spans the viewport. Its content stays capped at `--rkr-content`. This changes `default.css` for every theme, and bundled themes that set band styles get a check.
- **Section themes as tokens.** `default.css` defines `light`, `light-bold`, `dark` and `dark-bold`, each from tokens: `--rkr-section-<name>-bg`, `-fg`, `-heading`, `-link`. A theme sets the tokens and may add more names. The grid dialog lists the four built-in names plus any names a theme declares. How a theme declares extra names is left to the builder. A comment block in the theme file that the server reads is one option.
- **Visible wave edge.** `.rkr-section-wave` draws a wave in the band's background color over the next band, not an invisible spacer.
- **Section padding** comes from `--rkr-section-pad`.
- **Background image.** A band grid slot `bg` holds one image id. It renders through the image pipeline as a cover image behind the content. `collectBlockFigureIds` collects it. The grid dialog gets an image picker for it.
- **Alignment.** A grid slot `align`: `start` or `center`. It sets text and item alignment in the grid's cells.
- **Box.** A grid slot `box: true` draws the grid as a panel: background, padding and radius from `--rkr-box-bg`, `--rkr-box-fg`, `--rkr-box-pad` and `--rkr-radius`. This covers the "We're taking root" callout and the member and board cards.
- **Image mask.** A figure slot `mask`: `circle` or `rounded`. It applies to every cell of the figure. The blob and TV shapes become `rounded` with a theme-set radius.
- **Image link.** A figure slot `href`. When it is set, the image links there instead of opening the lightbox. It goes through `safeLinkUrl`.
- **Theming contract.** `docs/theming.md` documents every block class (`.rkr-section`, `.rkr-section-inner`, `.rkr-section-wave`, `.rkr-grid`, `.rkr-grid-cell`, `.rkr-box`, `.rkr-btn` and variants, `.rkr-marquee`, `.rkr-accordion`, `.rkr-progress`, `.rkr-embed`, `.rkr-macro-*`) and every token above, in the same change.

### 4. Site header and footer

Trial gap 2. The header is a hard-coded title with Home, About and Login. The footer is a hard-coded copyright line with a GitHub link. The trial faked both with macros pasted on every page and CSS that hid the real ones.

- **Header from settings.** `site.json` gains `logo` (an image id, rendered through the image pipeline), `menu` (an ordered flat list of label and href), `cta` (label and href), `social` (platform and URL, bundled SVG icons for Facebook, Instagram, YouTube, Mastodon, Bluesky and email) and `announcement` (text, optional href, on/off). The settings page edits them. Closing the announcement is remembered in the reader's browser, keyed to the text so a new announcement shows again.
- **Phones.** Under a width the theme sets, the menu folds behind a toggle that works without JavaScript.
- **Login.** When `menu` is set, the header shows no Login or Home link. Login stays at `/login`, and a small "Admin" link goes in the footer (`.rkr-site-foot-admin`, already in the theming contract). When `menu` is unset, the header is unchanged.
- **Footer from a block page.** A system page `_footer` renders in place of the hard-coded footer when it exists and its status is published. It is edited in the block editor like any page, so the address, link columns and buttons are ordinary text, button and grid blocks. The settings page links to it. When it is missing or a draft, the current footer renders. The template always appends the small `.rkr-site-foot-admin` link, so the author never has to place it.
  - Block-page slugs reject `_` (`VALID_SLUG` in `src/lib/block-pages.ts` and the routes in `src/routes/admin-blocks.ts`). Rather than widen that regex, a fixed set of system slugs (`_footer` for now) passes a separate check. The editor routes accept it, and `/:slug` and the indexer keep refusing every `_` slug as they do today. The same set is the place `_about` and `_site-banner` would join later.
- **The `page` root macro** (`macros/page.json`) holds the unused chrome data model. It is deleted, along with `ROOT_MACROS` and `getRootDefaults`.

### 5. Small blocks

Trial gaps 17 to 21, plus the embed item in DEFERRED.

- **Accordion** item bodies are markdown, rendered through the same pipeline as text blocks. This allows the newsletter archive's links.
- **Progress** shows the raised and goal figures as text under the bar. `slots.source: "site"` reads `site.json#campaign` (`goal`, `raised`), so every page shows the same figures. Today the real site's two thermometers disagree. The settings page edits `campaign`.
- **Marquee** repeats its text enough to fill the loop, so authors type it once. It stops for readers with `prefers-reduced-motion`.
- **Button** gets `size` (`normal`, `large`) and `arrow` (true appends →).
- **Embed** gets a palette entry and a dialog with a URL and a height. This is what the Google Form on `/contact` needs.
  - One allowlist feeds both the renderer (`EMBED_ALLOW` today) and the public CSP's `frame-src`: `docs.google.com`, `www.youtube-nocookie.com`, `player.vimeo.com` and `www.google.com` restricted to paths under `/maps/embed`.
  - The dialog rewrites share URLs to embed URLs before saving: `youtube.com/watch?v=…` and `youtu.be/…` become `youtube-nocookie.com/embed/…`, `vimeo.com/<id>` becomes `player.vimeo.com/video/<id>`, and a Google Form `…/viewform` link gains `?embedded=true`. A URL it can't map to an allowed host is refused in the dialog with the list of supported services.
- **Animated GIFs.** The trial's home-page portraits showed as stills. Check whether the image pipeline flattens animated GIFs. If it does, serve animated GIF originals unchanged and record the derivative trade-off in `docs/spec.md`.

### 6. Palette coverage

Marquee, accordion, progress and embed have no palette entry or dialog, so only hand-edited JSON can create them. Each gets a palette entry and a dialog in the style of `button-dialog-tree.ts`.

### 7. Seed macros and site themes

- **Seed macros.** rkr-blog ships the general section types the trial found as seeds in `macros/`, built on list slots and the grid slots above. Each has a description and fieldSchema, and none hard-codes co-op content:
  - `split`: image on one side, heading, text and up to two buttons on the other, side chosen by a select.
  - `photo-callout`: band with a background image and a boxed heading, text and button.
  - `people-grid`: list of photo, name, role and link, circle-masked, 4 columns.
  - `icon-grid`: list of image and caption, 4 columns.
  - `logo-wall`: list of image and link. Replaces the current placeholder.
  - `cards`: title plus a list of image, title, text and link. Replaces `cards-3`.
  - `hero`: the existing seed, plus an optional image beside the text.
  - `marquee-band`: band holding a marquee.
- **Updated seeds and existing sites.** `seedSiteMacros` never overwrites, so a site initialized earlier keeps its old `cards-3`, `logo-wall` and `hero`. Leave those files alone. Add `bin/site-admin macros` to list the seeds whose site copy differs from the shipped one, and `--update <name>` to replace one.
- **Site themes.** Themes are found in `<site>/themes/` as well as `static/themes/`, with the site's copy winning on a name clash. They are served from a public path the builder picks. Theme names stay `[a-z0-9-]+`, the file is served as CSS only, and the theme list on the settings page includes both places. The co-op theme lives in the co-op's site root, never in rkr-blog.

## Later specs

Each of these gets its own spec, in this order, after the parts above land:

1. **Listings and collections** (gap 14): a `list` block rendering one card per page with a tag, nested URLs such as `/recipes/pad-thai`, previous and next links, collection tags kept off the home index. The proposal's section 3 is the starting point.
2. **Events and calendar** (gap 15): the proposal's section 4.
3. **Forms** (gap 16): newsletter signup through Mailchimp's own form, and the contact form. It waits on the static publishing decision, because a static site has nowhere to post.

## Left to the builder

- The markup for the phone menu toggle, provided it works without JavaScript.
- The wave's SVG shape and how it is drawn (mask, inline SVG or background image).
- How a theme declares extra section theme names to the grid dialog.
- Migration numbering and the shape of the `kind` column.
- Splitting the work into commits and tests, within the repo's gate.
