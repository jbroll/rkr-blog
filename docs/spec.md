# rkr-blog — Feature specification

What the application does. Implementation-agnostic — an alternate stack
should be able to reproduce the application from this document.

For HOW this codebase delivers it, see [implementation.md](./implementation.md).
For local development setup, see [developer-quickstart.md](./developer-quickstart.md).

---

## 1. Goals

- Pages are JSON block trees (§8a). Markdown is the value language
  inside text blocks and the format of system posts.
- The editor never exposes markdown syntax, JSON, block ids or image
  ids to the author.
- Image pipeline retains the unmodified master forever, records edits
  declaratively, and serves cached derivatives.
- Imports from local upload, plain URL, Google Drive, OneDrive.
- Lazy derivative rendering by default; full pre-render available as an
  explicit operator action.
- Single author. No multi-user features in v1.

## 2. Non-goals

- Plugin / theme marketplace.
- Multi-tenant operation.
- Real-time collaboration.
- Pixel-exact fidelity while editing. The block editor's View mode
  shows the page as published; Edit mode overlays editing controls.

## 3. Architecture (behavioral)

```
client ──▶ front proxy ──▶ rendered derivative on disk (fast path)
                       ──▶ static assets on disk
                       ──▶ application server (everything else)
```

The fast path is the contract: once a derivative URL has been served
once, subsequent requests for the same URL bypass the application
server entirely and stream from disk with long-cache headers.
Application server is invoked only on cache miss, admin routes, and
API endpoints.

## 4. Runtime data layout

The deployed application owns a tree of state outside the codebase:

| location | content | properties |
|---|---|---|
| originals | one master file per logical image, content-addressed by sha256 | write-once; re-importing identical bytes is a no-op |
| sidecars | one JSON per logical image; the editing-state record | mutable; primary truth for op chain + redo stack |
| bakes | one client-baked post-ops image per id | optional; reproducible from original + sidecar |
| derivatives cache | per-format, per-variant rendered images | reproducible; safe to delete |
| posts | one markdown file per post | canonical content source |
| originals/videos | one master file per video, content-addressed by sha256 | write-once; re-importing identical bytes is a no-op |
| sidecars/videos | one JSON per video; trim/poster editing state | mutable; primary truth for trim op + poster time |
| video derivatives cache | per-derivative normalized mp4 + jpeg poster | reproducible; safe to delete |
| index DB | post index, jobs, sessions, OAuth | reproducible from posts (index) + filesystem (jobs); sessions and OAuth tokens are not reproducible |

Backup set: originals, sidecars, posts, index DB. Skip caches and
bakes — both are reproducible from the rest.

## 5. Sidecar schema

One JSON file per logical image. The "image" the post references is
`(original_id, ops_list)`. The author can edit `ops` after upload; each
save mutates the sidecar but never the original.

```json
{
  "version": 1,
  "original": "abcd1234ef56...",          // sha256 hex of master bytes
  "source": {
    "kind": "gdrive",                     // upload | url | gdrive | onedrive | wordpress
    "fileId": "1XyZ...",                  // provider-specific
    "fetched": "2026-05-06T14:22:11Z",
    "originalName": "DSC_0142.NEF.jpg"
  },
  "metadata": {
    "width": 6000, "height": 4000,
    "format": "jpeg",
    "exif": { "DateTimeOriginal": "...", "Model": "..." }
  },
  "ops":       [ /* author's click order */ ],
  "redoStack": [ /* ops popped via undo */ ],
  "outputs":   [ { "format": "webp", "quality": 85 },
                 { "format": "avif", "quality": 70 } ],
  "variants":  [ { "w": 400 }, { "w": 800 }, { "w": 1600 } ]
}
```

### Op types

| type | shape | meaning |
|---|---|---|
| `crop` | `{x, y, w, h}` | extract a region in current-canvas coords |
| `rotate` | `{degrees}` | any angle, stored normalised to `[0, 360)`; `0` is dropped. Multiples of 90° turn the canvas whole. Any other angle also crops to the largest axis-aligned rectangle, centred on the image centre, that fits inside the rotated image, so the output has no empty corners |
| `flip` | `{axis: 'horizontal' \| 'vertical'}` | mirror along an axis |
| `resample` | `{w?, h?, fit}` | downscale only — never enlarges |
| `perspective` | `{corners: [[x,y]×4]}` | rectify a tilted quadrilateral; tl/tr/br/bl in current-canvas coords |

### Op semantics

- `ops` is the author's click order. Coords on each op are interpreted
  in the canvas state at the time it runs (post-prior-ops). A `crop`
  recorded after a `rotate` therefore stores coords in the rotated
  canvas's coordinate space; after a non-orthogonal rotate that space
  is the inscribed rectangle, and validation bounds-checks later crops
  against it.
- `redoStack` is parallel: ops popped via undo, in pop order (last
  entry redoes first). Persisted with the sidecar so undo/redo survives
  reload. Adding a new op clears the redo stack — the standard
  linear-undo invariant.
- The executor simplifies adjacent logical no-ops at execution time:
  `rotate(a) + rotate(b)` combine into `rotate(a+b mod 360)` (drop if
  zero); same-axis flip pairs cancel. Storage stays in click order so
  the edits panel still reflects what the author actually did.
- `outputs × variants` enumerates the derivative set (per-format,
  per-width).
- A derivative's cache key is `hash(original_id, canonical-json(ops),
  variant, format, quality)`. Canonical-json sorts keys recursively,
  no whitespace, no trailing zeros, ASCII-only escaping, so
  semantically-identical ops produce identical hashes.

## 6. Image-edit model

The author opens an image in the editor, applies ops (rotate / tilt /
flip / crop / resample / perspective / undo / redo / delete-step /
reset),
and clicks **Save edits**.

- Each op click updates an in-browser local edit state for the active
  image; nothing crosses the wire per click. Live preview rebuilds in
  the browser, fast-path optimized so adding one op only runs that one
  op against the cached previous result.
- The Save edits button is disabled until the local state differs from
  the last server-known state (a "dirty" check).
- Save commits ops + redoStack to the sidecar and uploads the
  browser-baked post-ops image as a WebP. The bake is the
  authoritative pixel result for that op chain; the public renderer
  reads it as the source for variant downscale + format encode.
- `Reset edits` clears the local op chain (the master is untouched).
- Switching to another image preserves in-progress edits across the
  session. In-progress edits are persisted to OPFS on every change and
  restored automatically on reload. Reload while any image is dirty
  still surfaces a browser beforeunload warning (so the author
  consciously confirms the reload), but the edits survive it.
- Saving the post auto-commits any dirty image edits first; on
  failure the post save is aborted so partial state isn't published.

### Cropper

Sources from the local post-ops canvas, not the server preview, so
crop coords land in current-canvas space and crop appends to the op
chain instead of replacing it. Prior rotates / flips / crops survive a
new crop.

### Perspective rectify

A 4-corner drag modal with handles initially at the four image
corners. The author drags them to the corners of the region to
straighten. Save commits a `perspective` op whose corners are in
current-canvas pixel space. The output rectangle is sized from the
average of opposing edge lengths so a tilted square stays square.
Degenerate quads (three colinear corners) are refused with a status
message; perspective rectify requires the browser to support a
hardware-accelerated 2D pixel transform (the button is disabled
otherwise).

### Tilt

The 90° buttons stay as they are. A slider and a number input, both
`−45..45` in 0.1° steps, straighten a horizon. While either control
moves, the dialog preview rotates by CSS for instant feedback without
re-running the pipeline; **Apply** appends a `rotate` op of that angle
(a negative angle is stored as its `[0, 360)` equivalent, `−15` →
`345`), merged into a directly preceding `rotate` so a 90° turn
followed by a 3° tilt stores one `rotate 93`. The edits list shows
angles over 180° as negative (`345` → `rotate -15°`). Apply at 0° does
nothing.

## 6a. Standalone image editor

`apps/image-pwa` is the same crop / rotate / tilt / flip / perspective
/ resample tool set with no server behind it: open one image from a
file picker or by dropping it on the page, edit, download, repeat.
Nothing is uploaded or persisted; a reload starts fresh. It is
installable as a PWA. Where it is served
is a deployment choice (`DEPLOY_IMAGE_EDITOR`, see `RUNBOOK.md`); it is
off by default.

- **Open.** The picker is unfiltered; a file with a stated non-image
  type is refused with a status message. The image goes through the
  same EXIF bake and long-edge clamp as a blog upload before editing.
- **Edit.** Rotate ±90°, flip, crop and perspective modals, undo, redo.
  Tilt is a `−15..15` slider in 0.5° steps; the angle is absolute
  within one drag and merges into the rotation on release, after
  which the slider re-centres at 0.
- **Download.** Format picker: PNG (lossless), WebP or JPEG with a
  quality slider `0.3..1` (default WebP at 0.9). The file is named
  `<stem>-edited.<ext>` from the input filename.

## 7. Derivative rendering

```
GET /img/<originalId>.<ophash>.<format>
```

Front proxy serves the file directly when present. On miss the
application server:

1. Verifies the URL's `<originalId>` resolves to a sidecar and the
   `<ophash>` matches one of the declared `outputs × variants`
   combinations under the current ops.
2. Sources the pixels — bake when present, master + apply ops
   otherwise. Sources are tried in this order:
   - cache file at the URL (already-rendered derivative)
   - `bakes/<id>` (already-applied ops, just downscale + encode)
   - `originals/<id>` (apply ops, downscale, encode)
3. Writes atomically to the cache path; from there the front proxy
   serves it for every subsequent request.

A configurable wall-clock budget governs synchronous rendering. Past
budget the request returns `202 + a placeholder` and a job worker
finishes the render in the background; subsequent requests pick up
the cached result. The exact default is set by the implementation
(see `implementation.md` §5).

### Bake invalidation

`POST /admin/sidecar/:id/commit` atomically commits the ops chain and
an optional post-ops bake in a single request. Because both writes
happen together, there is no window where an old bake can be served
against new ops. On commit:

- Prior cache entries for the id are unlinked.
- If a bake is included, it replaces the previous bake atomically.
- A render request arriving during the commit falls through to the
  master + apply-ops path at most once; correct content is always
  served.

## 8. Content model

### Post storage

Pages the editor creates are JSON block pages (§8a). Markdown posts with
YAML frontmatter remain the format of system posts and of posts archived
by `blocks-migrate`:

```markdown
---
title: Post title
slug: post-title
date: 2026-05-06T14:00:00Z
status: published
---

Prose paragraph.

::figure{ids="abcd1234ef56" alts="Caption text"}

More prose.

::figure{ids="abcd…,ef01…,2345…" matrix=masonry}
```

Custom widgets use the [CommonMark generic directive](https://talk.commonmark.org/t/generic-directives-plugins-syntax/444)
syntax (`::name{attrs}`).

### System posts

A post whose slug starts with `_` is a system post: it lives in
`content/posts/` as markdown, but it is never
indexed, never listed, never searchable, and `GET /_<slug>` is always
404. Two exist:

| slug | served as | comments |
|---|---|---|
| `_site-banner` | the header banner figure on every page | none |
| `_about` | `GET /about`, a standalone page | none |

Both are created on demand from the settings page (`Create About` /
`Create banner`), which writes a stub file and returns to settings. The
block editor does not edit them (`DEFERRED.md`).
`/about` with no `_about.md` on disk is a 404, as is a malformed one.
`import-wp about` seeds `_about` from a WordPress page.

## 8a. Block pages and the editor

Pages are JSON block trees, not markdown files. Markdown survives only
as the value language inside `text` blocks. System posts (§8) and
archived legacy posts stay markdown.

### Storage

One file per page under `content/blocks/`, pretty-printed:

```json
{
  "version": 1,
  "body": [ { "type": "text", "markdown": "Hello." } ],
  "fields": { "title": "Hello", "slug": "hello", "status": "draft" }
}
```

`fields` holds title, subtitle, slug, status (`draft` or `published`),
date, tags and excerpt; other frontmatter keys from a migrated post are
kept as they were. The URL slug is `fields.slug`, not the file name, so
dated names from the WordPress importer and plain names from
`blocks-migrate` both work. The slug resolves to the first file, in sorted name order,
whose `fields.slug` matches and whose tree parses; read, save and create
all use that one rule. Corrupt files are skipped.

### Blocks

| Kind | Types |
|---|---|
| Containers | `section` (`theme`, `edge`), `row`, `col`, `flow` |
| Leaves | `text` (`markdown`), `figure`, `video`, `button` (`label`, `href`, `variant`), `list`, `marquee`, `accordion`, `progress`, `embed` |
| Macro instance | `{ "type": "macro", "macro": "hero", "slots": { ... } }` |

`text` markdown allows inline formatting, links, lists, headings and
code. It never carries image or widget syntax; images beside prose are
sibling `figure` blocks. `figure` and `video` slots keep the attribute
names of §9 and §10a (`ids`, `alts`, `captions`, `justify`, `matrix`,
`trim`, `poster`). `embed` is unsupported: the renderer emits an iframe for youtube.com,
youtu.be, vimeo.com, docs.google.com and maps.google.com URLs, but the
public CSP has no `frame-src`, so browsers block it. Nothing in the
editor, `blocks-migrate` or the WordPress importer creates one.

Rows and columns are flexbox and stack on narrow screens. There is no
free positioning and no per-page CSS; themes own the tokens.

A figure that opens the page, or opens a leading `flow`, is the page's
hero: it renders in the banner slot (above the header with
`bannerAboveHeader`) and the index teaser, not in the body. This is the
markdown rule for a post's leading `::figure`.

### Macros

A macro is `<site>/macros/<name>.json`: `description`, `defaults`, an
optional `fieldSchema` and a `tree`. The repo's `macros/` directory seeds
a new site and never overwrites an edited file. A page instance sets
only the slots it overrides.

- An unset slot follows the macro default and changes when the default
  does. A set slot, including an empty string, stays local.
- Precedence, lowest first: macro defaults, slots written inline in the
  macro's tree, instance slots.
- A macro whose tree is another macro instance fixes some of that
  macro's slots and leaves the rest open.
- A macro that reaches itself, directly or through others, renders a
  comment instead of looping.
- The `page` macro holds site-wide defaults (site title, menu,
  announcement, footer). It is not placeable.
- A macro file that is not valid JSON, lacks object `defaults`, or holds
  a node the page validator rejects is skipped and logged. Pages that
  use the other macros render; an instance of the skipped one renders a
  comment.
- The editor does not edit macro definitions; change the JSON file.
  There is no macro history or diff UI; git holds it.
- A definition holds at most three container levels. The editor refuses
  a drop that would pass that and nudges the author to split it. The
  renderer does not enforce depth.

#### Placeholders

`{{name}}` inside any string of a macro's `tree` is replaced by the
resolved slot `name`: text markdown, button labels and links, any other
slot value, at any depth, including inside a nested macro instance's
slots. Whitespace inside the braces is allowed and names use letters,
digits, `_` and `-`.

- A slot that is missing, or not a string or number, renders empty.
  There is no error and no literal `{{name}}` in the output.
- A substituted value is not scanned again.
- Page-body blocks that are not part of a macro tree do not expand
  placeholders.

#### Field types in the dialog

The macro dialog lists one field per key in `defaults`, in that order.
`fieldSchema[key]` supplies the label (the key itself when absent) and
the type:

| `type` | Control |
|---|---|
| `text`, `link` | single-line input |
| `markdown` | multi-line input |
| `select` | dropdown of `options`, first entry "Default (value)" |
| `image` | thumbnail with Choose image and Remove, via the media picker |
| none | single-line input; multi-line when the value or default has a newline |

Each field starts empty with the default as its placeholder. Typing sets
the override; clearing a touched field removes it, so the default flows
through again.

### The editor

`GET /admin/blocks/edit/:slug` renders the page as readers see it, plus
the editing chrome. View and Edit are two modes of the same page.

- **View** shows the public page: no palette, nothing editable.
- **Edit** makes text editable in place, shows the block palette, and
  outlines blocks on hover and selection. Ctrl/Cmd+E switches modes.
  Ctrl/Cmd+S saves now.
- **Text** saves on blur after typing; focusing and leaving a block
  never saves. Typing never shows markdown syntax. A text block whose
  formatting the editor cannot reproduce (an image inside text, a quote,
  raw HTML, an embed) is not editable in place. Selecting it says so,
  and it can still be moved, duplicated and deleted.
- **Selecting** a block shows a toolbar: drag handle, Up, Down,
  Duplicate, Configure, Delete. With a block selected: Alt+Up/Down move
  it, Ctrl/Cmd+D duplicates, Delete or Backspace deletes, Enter
  configures, Up/Down select the neighbour, Escape deselects. Escape in
  a text block leaves the text and selects the block.
- **Palette** groups: Basics (Text, Button), Media (Image, Video),
  Layout (Section, Row, Column), Sections (site macros). Drag an item
  onto the page, or focus it and press Enter. Insert lands after the
  selected block. If the selected block is a grid, insert lands at
  the end of that grid; use Move to put a block after it. With
  nothing selected, insert lands at the end of the page. Section always
  lands in the page body, after the selected block's top-level block.
- **Layout presets** all insert a grid: Row `cols: 2`, Column `cols: 1`,
  Section `cols: 1, band: true` (light, straight edge). The toolbar
  label follows the slots: a band reads Section, one column reads
  Column, otherwise Row (N columns).
- **Image and Video** show the new block and open its picker. Nothing
  saves or drafts until the dialog saves with something picked; Cancel,
  or saving with nothing picked, removes the block.
- **Phones**: the palette becomes an Add block bottom sheet.
  Phone preview narrows the page body to phone width. It does not make
  the site's viewport media queries fire, so rules keyed on the screen
  width stay in their desktop state.
- **Dialogs** use one modal. Figure: image list (add from this computer,
  Google Drive, OneDrive or Google Photos; reorder, remove, alt text,
  caption, edit image), layout. Video: one video from the same sources, with caption and layout.
  Button: label, link, style. Macro: the fields above. Page settings:
  title, subtitle, status, publish date (filled in when the status becomes published), tags,
  excerpt. Authors never see JSON, block ids or image ids.

### Saving

Every change saves the whole tree: `POST /admin/blocks/:slug` with
`{ tree, baseVersion }`. The URL slug wins over `fields.slug`.

- `version` is a hash of the file's bytes. A save whose `baseVersion` no
  longer matches the file gets `409 { error: "conflict", version }`, and
  the editor offers Load latest (discard local changes) or Keep mine (save over the newer version). A request
  without `baseVersion` (scripted clients) overwrites.
- A save that would create a file whose name another page already uses
  gets `409`. An invalid tree, a title, subtitle, status, date or
  excerpt that is not a string, or tags that are not a list of strings
  get `400` and are never stored. A tree that breaks a hard rule gets
  `400 { error: "invalid", message, path }`: the editor selects the
  block at `path`, shows `message` in its toolbar, shows Not saved, and
  does not retry until the tree changes.
- A save from an editor bundle older than the running server (its
  `X-Rkr-Build` differs) gets `426`; the editor asks for a reload.
- New page refuses a slug that a fixed route answers (`about`, `search`,
  `new` and the others in `src/lib/reserved-slugs.ts`) and a slug the
  index already holds, such as an unarchived markdown post's.
- A save updates that page's index entry (row, tags, search text) and
  queues derivative renders for its media.
- The tree is written to an IndexedDB draft before each request and
  cleared once the server has it. After a failed or offline save the
  draft restores on reload. The indicator shows clean, editing, saving,
  unsaved, offline or conflict.
- Leaving with unsaved work asks for confirmation.
- **Logout** with drafts the server lacks (compared page by page) shows
  "N pages have changes that never reached the server. Signing out
  deletes them." with the page titles. Cancel, which has focus, keeps
  the drafts and the session; Sign out and delete clears them, then
  signs out. With none, or when the drafts cannot be counted within 3
  seconds, Logout signs out at once and keeps any drafts. The page the
  logout lands on drops the cached editor pages and the admin worker,
  never drafts.
- **Delete page** (Page settings) asks for confirmation naming the page,
  then removes its file and index entry and returns to the pages list.
  Its comments go with it, as a deleted markdown post's did. If a
  markdown post or another file still carries the slug, that one takes
  the slug back.
- Editor pages open offline after one online visit (`spec-offline.md §3`).

## 9. Image widgets

The post body uses a single `::figure` directive for all image display.
One directive collapses what used to be five (`::image`, `::diptych`,
`::triptych`, `::gallery`, `::carousel`); layout is described by
attributes rather than by directive name. See "Migration plan" below
for the transition strategy from the legacy directives.

### Syntax

```
::figure{ids="<id>[,<id>…]" [matrix=NxM|justified[:H]|masonry[:N]]
         [justify=J] [width=…] [aspect=W:H] [fit=cover|contain]
         [alts="…,…"] [captions="…|…"] [caption="…"] [timer=N]}
```

`ids` is the only required attribute; all others have defaults.

### Attributes

| attribute | required | default | purpose |
|---|---|---|---|
| `ids` | **yes** | — | comma-separated sha256 hex (6+ char prefix or full 64) |
| `matrix` | no | `1x1` | display layout; see Matrix table |
| `justify` | no | `center` | block placement; see Justify table |
| `width` | no | (justify default) | block width with explicit unit: `400px` or `60%` |
| `aspect` | no | (first image's native aspect) | per-cell display aspect ratio, e.g. `16:9` |
| `fit` | no | `cover` | how the image fills its cell: `cover` (fill, crop edges) or `contain` (letterbox) |
| `alts` | no | — | comma-separated alt text, parallel to `ids` |
| `captions` | no | — | pipe-separated per-image captions (pipe avoids comma collisions in alts) |
| `caption` | no | — | one caption for the whole `<figure>` |
| `timer` | no | — | autoplay seconds when carousel mode kicks in (cap 60) |

Attributes that don't apply to the chosen `matrix` mode (e.g. `aspect`
+ `fit` under `justified` / `masonry`; `width` under `full` / `bleed`)
are silently ignored — the directive is forgiving so authoring stays
quick.

### Matrix

| value | meaning |
|---|---|
| `NxM` | uniform grid: N rows × M cols, every cell at the same `aspect`. Default: `1x1`. |
| `justified` | Flickr-style: rows of varying-width images at uniform row height. `:HHH` overrides row height (default ~240px). |
| `masonry` | Pinterest-style: columns of varying-height images at uniform column width. `:N` overrides column count (default 3). |

`aspect` and `fit` apply only to `NxM`. In flow modes (`justified`,
`masonry`) each image renders at its native aspect — that's the whole
point of the flow.

### Justify

| value | layout |
|---|---|
| `center` | block centered in the prose column; `width` defaults to 100% of column |
| `left` | float left; prose wraps right; `width` defaults to 40% on desktop, 100% on mobile |
| `right` | mirror of `left` |
| `full` | spans the wider content-column width (breaks out of prose column); ignores `width` |
| `bleed` | spans the full viewport width (breaks out of content column too); ignores `width` |
| `inline` | (figures only; the video dialog hides it, and the markdown migration maps imported inline figures to `center`) image flows inline with surrounding text at ~1.5em; `matrix`, `aspect`, `fit`, `width`, `caption` all ignored. Use only with a single `id` (extra ids are ignored). |

### Sizing semantics

The image's native aspect ratio is always preserved. `aspect` controls
the *cell* aspect ratio in `NxM` mode: the renderer reserves a box at
`aspect` per matrix cell and fits the image inside per `fit`.

- `fit=cover`: image fills the cell; if aspects differ, edges are
  cropped (typical photo-blog behavior).
- `fit=contain`: image fits inside the cell; if aspects differ, the
  cell shows letterbox bars (technical / art images).

When `aspect` is omitted, the cell aspect defaults to the first
image's native aspect (read from its sidecar at render time).

The whole figure's display aspect is `aspect × cols : rows` — used to
reserve layout space and avoid CLS as images load.

### Carousel mode (overflow)

When `len(ids) > matrix.rows * matrix.cols` in `NxM` mode, the figure
becomes a horizontal-scrolling carousel: **rows stay fixed**, columns
expand to hold every image. The visible window is `matrix.cols` wide;
scroll/swipe/click advances by that many columns.

For example, `matrix=2x3` with 8 ids renders 2 rows × 4 cols (the
last column is half-full); the viewport shows 3 cols at a time. Same
attributes accepted in the visible-grid case (`aspect`, `fit`, etc.)
apply per cell.

`timer=N` autoplays the scroll at N seconds per page (cap 60). When
omitted, advance is manual only (prev/next, swipe, keyboard). Same
accessibility constraints as today's `::carousel`: pauses on
hover/focus/page-hidden, reduced-motion respected, accessible
play/pause when `timer` is set.

`justified` / `masonry` modes don't carousel — they grow vertically
to fit every image.

### Edge cases

- `matrix` omitted with N images → default `1x1`. With `N>1` ids, the
  excess overflows into carousel mode (so a single id list with no
  matrix attribute renders sensibly even without a matrix override).
- Over-allocated matrix (`matrix=2x3` with only 2 ids) → render the
  excess cells empty; the author asked for that layout. No
  auto-shrink — keeps the rendered result predictable.
- `matrix=1x1` with N>1 ids → carousel with one cell visible at a
  time; rows stay fixed at 1 → the carousel is a horizontal strip.
- `ids` empty or all unresolvable → the figure is replaced by an HTML
  comment so authoring errors are visible without breaking the page.
- Inline mode with multiple ids → second-and-later ids ignored; only
  the first renders inline.

### Render output

A single `<figure class="rkr-figure rkr-justify-{justify}
rkr-fit-{fit}">` containing either:
- a CSS-grid `<div>` (matrix mode, no JS), or
- a CSS-grid scroll-snap track + small JS controller (carousel mode).

Each cell wraps a `<picture>` with one `<source>` per format and
srcset entries from the widget's declared variants, plus a JPEG
fallback (kept aligned with `DEFAULT_VARIANTS × DEFAULT_OUTPUTS` at
ingest — see test/lib/widget-fallback-alignment.test.ts).

`<figcaption>` appears only when `caption` is set. Per-image
`captions[i]` go inside that cell's `<picture>` wrapper.

### Lightbox

Unchanged: clicking any cell overlays it fullscreen; ESC or
click-outside dismisses. The block `caption` (if any) — or the per-
image `captions[i]` — appears as the lightbox caption.

### Migration plan

The legacy directives (`::image`, `::diptych`, `::triptych`,
`::gallery`, `::carousel`) ship in posts on disk today. Transition:

1. **Spec freeze** (this document) defines the target syntax. ✅
2. **Implement `::figure`** as a new widget alongside the legacy ones. ✅
3. **Migrate the WP importer** to emit `::figure` for all imported
   posts. Existing imported posts on disk keep working via legacy
   widgets. ✅
4. **Markdown ⇄ figure conversion** of the full attribute set in
   prose-markdown. ✅
5. **One-shot migration tool** (`site-admin migrate-figures`) was
   shipped to rewrite legacy directives in `content/posts/*.md`. After
   the editor unification + reseed, no legacy directives remain in any
   live post; the tool was deleted as dead code. ✅
6. **Server-side legacy widget deletion**: drop
   `src/widgets/{image,diptych,gallery,carousel}.ts`, their tests,
   their CSS, and the WidgetRegistry registrations. The figure widget
   becomes the only image directive the public renderer recognises.
   Constants-alignment test shrinks to one widget × one fallback. ✅
7. **Single figure type**: image, gallery and carousel are one `figure`
   whose layout follows from `matrix` and the `ids` count. All
   prose-markdown emit and parse goes through one path. ✅

Every directive on disk is `::figure`, and the public renderer has one
image widget.

## 10. Remote image import

| Provider | Mechanism | Auth |
|---|---|---|
| Local upload | multi-file input + drag-drop / paste into the editor | session |
| Plain URL | server-side fetch (size + content-type capped) | session |
| OneDrive | Server-driven browser dialog + Graph API | OAuth2 |
| Google Drive | Server-driven browser dialog + Drive v3 (`drive.readonly` scope) | OAuth2 |
| Google Photos | Picker-API session (pick in Google UI) + server download | OAuth2 (`photospicker.mediaitems.readonly` grant) |

Common path: picker returns a file handle → server streams bytes →
sha256 during stream → if hash already in originals, dedupe; otherwise
atomic-rename into place → write sidecar with `source.kind` set.
Provenance is recorded but the original is treated identically
regardless of source.

## 10a. Video (isolated v1)

A single-file `::video` widget mirrors the image pipeline but stays
isolated from `figure.ts`/`lightbox`. One normalized mp4 per logical
video (no HLS/DASH, no adaptive renditions); a jpeg poster; non-
destructive trim.

- **Ingest** (`POST /admin/upload/video`): stream → sha256 → ffprobe →
  cap checks (bytes/duration/width from `config/site.json#videoCaps`,
  defaults 500 MiB / 300 s / 1920w) → dedupe into
  `originals/videos/<aa>/<bb>/<id>.<ext>` → `sidecars/videos/<id>.json`
  → eager transcode + poster.
- **Sidecar** (`sidecars/videos/<id>.json`): version 1, source probe
  metadata, `ops: [{kind:"trim", startMs, endMs}]`, `poster.timeMs`.
  Trimming rewrites the sidecar, never the original.
- **Transcode** (`renderVideoDerivative`): ffmpeg h264/aac yuv420p
  `+faststart`, max 1920w, preset fast CRF 23 → `cache/video/<id>.<ophash>.mp4`;
  poster jpeg from the transcoded file at `posterTimeMs` (relative to
  trim start) → `cache/video/<id>.<ophash>.jpg`. Poster ophash includes
  the poster time so a `poster=` change invalidates the immutable URL.
- **Serving** (`GET /video/:filename`, `GET /video/poster/:filename`):
  Range/206 + 416, `Cache-Control: immutable`, render within budget with
  202 + client retry on timeout (mirrors `/img`). Apache rewrites
  `/video/*` hits straight to `/cache/video`.
- **Widget**: `::video{ids="<64-hex>" trim="2-45.5" poster="1.5" controls
  autoplay muted loop width=... caption="..."}`. `autoplay` forces
  `muted`+`playsinline`. Unknown id renders a comment. Missing/invalid
  trim/poster render a comment.
- **Editor**: the Video palette item opens the video dialog: one video
  from the same sources as images, a caption and a layout. Trim and
  poster are set through `POST /admin/video/:id/trim`; the editor has no
  control for them yet (`DEFERRED.md`).

OAuth tokens are stored encrypted at rest with a server-held key.

## 11. HTTP routes

Routes are split across `src/routes/*.ts` files (each kept under
the 500-line size cap). Auth required is `session` (Google OAuth +
allowlist) unless noted; `bearer` (ADMIN_TOKEN) endpoints accept
either mechanism, useful for scripted clients.

```
# Public — public.ts
GET    /                              rendered post index (paginated)
GET    /about                         about page
GET    /search                        full-text search page
GET    /:slug                         rendered single post
GET    /:y/:m/:d/:slug                legacy WordPress permalink → 301 /:slug (published only)
GET    /pages/:slug                   old block-page URL → 301 /:slug (published only)
GET    /img/:filename                 derivative image (cache-miss handler)
GET    /video/:filename               derivative mp4, Range/206-capable (cache-miss handler)
GET    /video/poster/:filename        derivative jpeg poster (cache-miss handler)
POST   /:slug/comments                anonymous reader comment submission

# Liveness — server.ts
GET    /health                        liveness probe

# Auth — auth.ts
GET    /login                         login page (token + Google buttons)
GET    /admin/auth/google/start       Google OAuth begin (redirect)
GET    /admin/auth/google/callback    Google OAuth code exchange
POST   /admin/auth/token-login        ADMIN_TOKEN bearer login (form)
POST   /admin/logout                  destroy session

# Admin core — admin.ts + admin-shell.ts
GET    /admin                         302 → /admin/blocks
GET    /admin/editor                  404: retired, points at /admin/blocks
GET    /admin/view/:slug              302 → /admin/blocks/edit/:slug
POST   /admin/upload                  multipart, streams to originals
POST   /admin/upload/video            multipart video ingest → probe + transcode + poster
POST   /admin/video/:id/trim          non-destructive trim + poster time (rewrites sidecar only)
POST   /admin/reset                   wipe posts/images/cache (bearer)

# Admin block pages — admin-blocks.ts
GET    /admin/blocks                  pages list (query: q filters by title)
GET    /admin/blocks/new              new-page form (title, slug)
POST   /admin/blocks/new               create an empty draft page → 303 to its editor
GET    /admin/blocks/edit/:slug       the editor (View / Edit)
GET    /admin/blocks/:slug            page JSON (title, tree)
POST   /admin/blocks/:slug            save the whole tree; 400 invalid, 409 conflict or file collision
POST   /admin/blocks/_render          re-render a posted tree for the editor; never writes
POST   /admin/blocks/:slug/delete     delete the page file and its index entry
GET    /admin/blocks/macros           palette entries for the site's macros
GET    /admin/blocks/preview/:macro   one macro rendered with its defaults

# Admin posts — admin-posts.ts
GET    /admin/posts                   301 → / (old bookmarks)

# Admin image edit — admin-image-lookup.ts + admin-sidecar-edit.ts
GET    /admin/preview/:id             302 to a derivative URL the editor uses as <img src>
GET    /admin/original/:id            stream the master bytes for the client canvas pipeline
GET    /admin/sidecar/:id/meta        sidecar dimensions + ops + redoStack
POST   /admin/sidecar/:id/commit      replace ops + (optional) post-ops bake upload (atomic)

# Admin settings — admin-settings.ts
GET    /admin/settings                read site title / tagline / theme
POST   /admin/settings                update site config
POST   /admin/settings/site           set title + tagline via JSON (WP importer)
POST   /admin/settings/banner         set site-wide banner image id via JSON
POST   /admin/settings/gdrive/disconnect   revoke gdrive tokens for the session user
POST   /admin/settings/onedrive/disconnect revoke onedrive tokens for the session user
POST   /admin/reindex                 rebuild post index + FTS from markdown files
GET    /admin/banner/edit             create _site-banner.md if absent, back to settings
GET    /admin/about/edit              create _about.md if absent, back to settings

# Admin comments — admin-comments.ts
GET    /admin/comments                comment moderation list
POST   /admin/comments/:id/:action    approve / reject / delete a comment (action ∈ {approve,reject,delete})

# Admin tags — admin-tags.ts
GET    /admin/tags                    tag autocomplete (query param: q)

# Admin imports — admin-import-url.ts + integrations-{gdrive,onedrive}.ts
POST   /admin/import/url              server-side fetch
POST   /admin/import/gdrive           Google Drive Picker payload
POST   /admin/import/onedrive         OneDrive Picker payload

# Integrations — integrations-gdrive.ts + integrations-onedrive.ts
GET    /admin/integrations/<p>/connect          OAuth initiation
GET    /admin/integrations/<p>/callback         OAuth code exchange
GET    /admin/integrations/<p>/picker-config    Picker SDK config
GET    /admin/integrations/<p>/status           connected user info
GET    /admin/integrations/<p>/access-token     short-lived token for Picker SDK
POST   /admin/integrations/<p>/disconnect       revoke tokens

# OneDrive-only extras (v8 File Picker protocol)
GET    /admin/integrations/onedrive/picker-token   resource-scoped token for the File Picker v8 authenticate handler
GET    /admin/integrations/onedrive/files          browse a OneDrive folder (query: folderId, nextLink)
GET    /admin/integrations/onedrive/thumbnail      proxy a OneDrive item thumbnail (query: itemId)
```

(`<p>` ∈ {`gdrive`, `onedrive`})

## 12. Operator commands

A single CLI binary exposes everything an operator can do outside the
editor:

```
init                    create the runtime data tree, run migrations
migrate                 run pending migrations
reindex                 rebuild post index from content/
render                  pre-render every variant for every sidecar
render --post <slug>    pre-render one post
render --since <date>   pre-render posts newer than date
render --force          re-render even existing cache entries
gc                      delete cache entries that no sidecar references
verify                  rehash originals; flag mismatches
jobs failed             list jobs in state='failed' from the queue (id, kind, attempts, error)
import-wp list <base-url>                    list posts on a WordPress source
import-wp post <base-url> <id-or-slug>       import one WP post + every image it references
import-wp push <base-url> <slug> --to <url>  push one post to a remote rkr-blog via /admin
import-wp about <base-url> --to <url>        push the WP page `about` as the `_about` system post
import-wp site-banner <base-url> --to <url>  push the WP header image as the `_site-banner` system post
import-wp-comments <base-url>               import approved comments from a WordPress source
wp-dump <dump.sql> <out.db>                 convert a mysqldump file to SQLite
import-wp … --from-dump <db> --uploads <d>  read a backup instead of a live WordPress site
fix-wp-dates                                repair WP-imported post dates using the filename prefix as truth
blocks-migrate --post <slug> [--out f]      print one markdown post as a JSON block tree
blocks-migrate --all [--force] [--dry-run]  write a JSON twin per markdown post (§8a)
blocks-migrate --archive [--dry-run]        move twinned markdown to content/posts-legacy/
reset --to <target-url> --token TOKEN wipe all post + image runtime data on a remote rkr-blog
user invite <email>     add to the allowlist (owner / editor role)
user list / remove
server [--port N]       run the application server
```

`render` warms the cache (e.g. after a bulk ops change). `gc` walks
every sidecar, builds the set of valid `<id>.<ophash>.<fmt>` filenames,
deletes everything in the cache not in the set; idempotent.

## 13. Auth

- **Social login only.** Sign in via Google (Apple deferred). No
  passwords stored anywhere.
- **Invite-only allowlist.** A successful Google authorization only
  creates a user if the email is on the allowlist; an uninvited email
  gets a 403. There is no first-login-becomes-owner bootstrap — the
  operator invites their own email before their first login, so nobody
  who reaches the URL first can claim the site.
- **Roles.** `owner` and `editor` are stored on the user and assigned
  from the invite. `requireOwner` 403s a non-owner on 18 routes,
  covering stored provider credentials (Drive and OneDrive connect,
  OAuth callback, access/picker token, disconnect), site config
  (`/admin/settings`, `/admin/settings/site`, `/admin/settings/banner`,
  the two provider disconnects), whole-site export and import, and
  `POST /admin/reset`. An `editor` keeps the rest: post CRUD, upload,
  video, comments, tags, preview, sidecar edits, import-url, provider
  status / import / fetch, and the editor shell. `POST /admin/reindex`
  and `POST /admin/posts/:slug/delete` stay on `requireUser` by
  choice; see `DEFERRED.md`.
- **Sessions:** server-side, 30-day fixed expiry from login time;
  `last_seen_at` is updated on each authenticated request but does
  not extend the expiry window. Cookie is `HttpOnly`, `Secure`,
  `SameSite=Lax`.
- **Per-user picker tokens** (Drive, OneDrive) live encrypted in the
  index DB.
- **CSRF**: Origin/Referer guard for state-changing methods, plus
  `SameSite=Lax` session cookie as the primary line. The cookie alone
  blocks the realistic threat model (top-level GET navigation,
  cross-site form POST); the Origin check is defense-in-depth in case
  a future browser-quirk or extension bypasses SameSite. When a
  deployment splits its reader and admin hostnames, the reader origin
  is confined to paths outside `/admin` — a shared registrable domain
  means `SameSite=Lax` alone would not stop a page on the reader host
  from forging an admin POST.
- **Bearer-token bypass for scripted clients.** When the env var
  `ADMIN_TOKEN` is set, requests carrying `Authorization: Bearer
  <ADMIN_TOKEN>` skip the cookie path and attach a synthetic admin
  user (constant-time match). CSRF guard is also skipped on these
  requests since browsers don't auto-send `Authorization` headers; the
  token itself is the CSRF defense. Used by the WordPress importer's
  push mode and any future scripted admin tooling. Leave `ADMIN_TOKEN`
  unset to disable the bridge entirely.

## 14. Comments

Readers submit comments without an account via `POST /:slug/comments`.

### Form and display

The form collects Name, Email, and Comment. Email is required but
never shown; there is no website field, and author names render as
plain text. It works without JavaScript: a native POST answers with a
303 back to `/:slug?submitted=1#respond`, which shows a "received,
will appear shortly after review" notice above the form. With
JavaScript the same POST goes over `fetch` and the notice is swapped
in without a reload; any failure falls back to the native submit.

Published comments render below the post oldest-first, replies
indented one level under their parent, each with author name, date,
and escaped body. The post header carries a comment bubble flush
right: a speech-bubble icon with the published count (top-level plus
replies), or no number at zero, linking to `#respond`. It is an
in-page anchor, no script.

### Spam triage

Each submission is written with `status = 'pending'` and a `classify` job is enqueued. The job calls the Ollama proxy (`SPAM_MODEL`, default `llama3.2:3b`) and auto-publishes ham; spam, timeouts, and errors leave the comment `queued` for manual review. The fail-safe is explicit: unscored comments never auto-publish. If `OLLAMA_BASE_URL` is unset the classify step is skipped and all comments go to `queued`.

Pre-LLM guards run first, in this order:

- Honeypot: a hidden `website` field. A non-empty value gets the same
  success response as a real submission and nothing is stored.
- Validation: name, email, and body required; length caps 80 / 200 /
  5000; email shape; no control characters.
- Per-IP rate limit, 5 submissions per 10 minutes.
- Minimum fill time: a submission under 3 s after the form rendered
  goes straight to `queued` and skips the classifier.

There is no CAPTCHA and no max-links heuristic.

### Email notification

The owner can be emailed when a comment resolves out of `pending`.
The level is a Settings value, `commentNotify`:

| level | mails on |
|---|---|
| `off` | never |
| `ham` (default) | a comment auto-publishing |
| `queued` | a comment landing in the moderation queue (spam, classifier failure, too-fast fill) |
| `all` | both |

Manual approve in moderation never mails. Delivery needs SMTP
configured (`SMTP_HOST`) and a recipient: the Settings `notifyEmail`
address, falling back to `NOTIFY_TO`. Without either the mailer is a
silent no-op. Mail is plain text: subject `New comment on "<title>" by
<name>` or `[moderation] Held comment on "<title>" by <name>`; body
has author name and email, post title, the comment verbatim, a
permalink to the comment on `PUBLIC_BASE_URL`, and a link to
`/admin/comments` on `ADMIN_BASE_URL`.

### Moderation

`GET /admin/comments` lists queued → published → rejected comments. Actions: approve, reject, delete. Gated by admin auth.

### Threading

One level only. A reply's `parent_id` must reference a `published` top-level comment (one with no `parent_id` of its own). The data model does not support deeper nesting. WordPress-imported threads deeper than one level are flattened to top-level.

## 14a. Header navigation and search

Every public page's header has the site title (linking to `/`), a
nav of `Home` (omitted on the index itself), `About`, and `Login` or
a `Logout` form.

The index page has a right-hand rail holding a sort toggle
(newest/oldest first), a search box, and tag pills. The search page
keeps the search box, pre-filled, and drops the sort toggle because
results are ranked by relevance, not date.

`GET /search?q=` is a no-JS GET form. Words are AND-ed, the last word
matches as a prefix, and there are no user-facing operators; anything
that is not a letter, digit, or underscore is stripped, and the query
is capped at 200 characters. Title, tags, and plain-text body are
indexed; title outranks tags outranks body. Anonymous visitors see
published posts only, a logged-in admin also sees drafts. Results are
a single list of at most 50 hits, each with title, date, and a body
snippet with the matching words marked. An empty or all-punctuation
query renders a prompt; no hits renders "No results for …". No
pagination, fuzzy matching, or typeahead.

The index is rebuilt by `reindex`, which every post save and delete
already runs, so search is current without a separate step.

## 15. Deployment configuration

Per-deployment environment surface:

| variable | default | purpose |
|---|---|---|
| `SITE_ROOT` | `/var/www/site` | root of the runtime data tree |
| `PORT` | `3000` | application server listen port |
| `HOST` | `127.0.0.1` | listen interface (front proxy reverse-proxies) |
| `SITE_TITLE` | `rkroll` | header title + `<title>` suffix |
| `SITE_TAGLINE` | (none) | optional subtitle |
| `PUBLIC_BASE_URL` | (required) | origin readers see; permalinks in comment notifications, and part of the CSRF allowlist |
| `ADMIN_BASE_URL` | `PUBLIC_BASE_URL` | origin the admin UI and every OAuth `redirect_uri` live on; set only when readers and admin are served from different hostnames |
| `GOOGLE_CLIENT_ID` | (required) | Google OAuth |
| `GOOGLE_CLIENT_SECRET` | (required) | Google OAuth |
| `ADMIN_TOKEN` | (unset) | when set, enables `Authorization: Bearer` admin auth for scripted clients (WP importer push mode); leave unset to disable |
| `LOG_LEVEL` | `info` | server log threshold |
| `SITE_THEME` | `default` | active theme name; overridden by the persisted `config/site.json#theme` value set via admin settings |
| `MICROSOFT_CLIENT_ID` | (unset) | OneDrive OAuth — required to enable OneDrive integration |
| `MICROSOFT_CLIENT_SECRET` | (unset) | OneDrive OAuth secret |
| `MICROSOFT_TENANT_ID` | `common` | OneDrive OAuth tenant; `common` accepts any Microsoft account |
| `OLLAMA_BASE_URL` | (unset) | base URL of the Ollama proxy for comment spam classification; leave unset to disable LLM triage |
| `OLLAMA_TOKEN` | (unset) | bearer token for the Ollama proxy |
| `SPAM_MODEL` | `llama3.2:3b` | Ollama model used for spam classification |
| `SPAM_TIMEOUT_MS` | `8000` | per-attempt timeout on the classifier call |
| `SPAM_MAX_ATTEMPTS` | `3` | classifier attempts before the comment is queued unscored |
| `SMTP_HOST` | (unset) | SMTP server hostname for email notifications; leave unset to disable email |
| `SMTP_PORT` | `587` | SMTP port; 465 switches to implicit TLS |
| `SMTP_USER` | (unset) | SMTP login username; omit for an unauthenticated relay |
| `SMTP_PASS` | (unset) | SMTP login password |
| `SMTP_FROM` | `SMTP_USER` | From address for outgoing notification email |
| `NOTIFY_TO` | (unset) | Recipient for comment notifications when Settings has no `notifyEmail` |

The session-signing and token-encryption secret lives in
`$SITE_ROOT/data/secret.key` (mode 0600), generated by `init` if
absent.

## 16. Out of scope (v1)

Adding any of these requires reopening the spec.

- Plugin / theme marketplace.
- Multi-tenant operation.
- Real-time collaboration.
- Cloud storage for originals or cache.
- A CDN in front of the front proxy.
- WebSockets / SSE / any real-time channel.
- ImageMagick (only one image library is in scope at a time).
