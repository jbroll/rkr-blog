# Reusable blocks with nesting — design (rev 2: JSON pages)

Intent: let a non-technical editor assemble rich pages from branded, reusable pieces without hand-placing elements or thinking about phones, and without the Squarespace tedium of rebuilding the same band on every page.

Why now: the page-design inventory (`docs/proposal-page-design.md`) found 445 sections and repeated hand-copied card sets (board grid on `/about`, home carousel, three-card bands and Member-Owner of the Month on `/news`, five collection grids). Positioning and media-size adaptation in Squarespace are near impossible, and reusable branded blocks today require manual duplication (thermometer figures disagree: $747,485 vs $429,085). This design is the editing model that makes the page-design proposal authorable.

## Goals

- Pages are JSON macro trees, not markdown files. The top-level page is itself a macro invocation: slots for chrome (menu, announcement, footer) plus an ordered body.
- Slots are named nested objects or arrays of objects. Example: `hero { heading, text, bg, buttons[] }`, `cards { title?, items[{ image, title, href }] }`, `flow { blocks[] }`.
- Markdown survives only as the value language inside `text` widgets. A text block is `{ type: "text", markdown: "..." }` holding bold, links, lists. The editor shows it rich, stores markdown, the build renders that one string. No page-level markdown, no fence editing.
- Flowing articles are arrays of mixed widgets: `flow.blocks = [text, figure, text, video, button, ...]` in page order. This is the direct translation of today's mdast `Root.children` sequence.
- Specialized bands (hero, split, 3-cards, logo wall, newsletter band, event band) are macros: prebuilt trees of row/col plus leaves with branded defaults. Insert, override a few slots, done.
- Parameters with fallback give linked behavior with no link concept: unset follows the macro default, set stays local. Changing a default flows to every use that left it unset on the next build. A defaults-only macro is currying: it fixes some slots of another macro and leaves the rest open.
- Nesting via composition: each macro definition is at most depth 3 (containers counted). A page reaches any depth by stacking macros and rows/cols. A detail macro may be complex inside but presents as one block with a few fields.
- Responsive by construction: divs plus flexbox/grid, split/columns stack under ~720px. No per-device adjustments, no pixel placement.
- Editor hides structure: palette plus inline fields, duplicate and save-as-macro, depth shown visually, desktop/phone preview toggle proving adaptation.

## Non-goals

- No free positioning (no Fluid Engine drag-to-place).
- No per-page custom CSS or colors; themes own tokens per `docs/theming.md` contract.
- No inline (mid-sentence) images. Dropped: `justify=inline` exists today (`src/widgets/figure-attrs.ts`, `src/widgets/figure.ts`, admin option "inline (small, in text flow)") but is an edge case. Migration maps existing inline figures to small centered figures.
- No versioned macro history or diff UI in v1; pretty-printed JSON in git is enough.
- No live multi-user editing.

## Anti-goals

- Failing the static build because an author nested too deep. Depth guidance belongs in the editor, not as a build error.
- Exposing JSON, fences, ids, or hex image ids to authors in normal flow.
- Reintroducing two modes (linked vs detached) with badges and link management. Rejected in favor of defaults-plus-overrides.

## Constraints

- Follows `docs/proposal-page-design.md` §2–§5 block inventory; does not change its decisions (system fonts, no HubSpot, placeholder listing preview offline).
- Today's markdown pages migrate mechanically: frontmatter becomes page/macro top-level fields, body block sequence becomes a `flow.blocks` array, `::figure`/`::video` attributes become widget slots. Importers emit JSON trees going forward.
- `config/site.json` goes away as a separate concept. Its contents (title, tagline, logo, menu, CTA, social, announcement, footer, fundraising numbers) become slots on the root page macro with site-wide defaults. There is no special settings file to keep in sync; there is the first macro the user creates.
- Rendering is server/build HTML plus small JS only where needed (carousel, accordion single-open, marquee pause on reduced motion). No new runtime deps assumed; builder picks.
- Macro expansion must detect cycles (macro using itself directly or transitively) and render a comment instead of looping.
- Pretty-printed JSON with sorted keys keeps git diffs readable.

## Decided: the how

1. **Model.** Page = `{ macro: "page", slots: { chrome: {...}, body: [ ... ] } }`. Body items are `section{theme, edge, bg, children}` | `row{children}` | `col{children}` | macro instance `{ macro: "hero", slots: {...} }` | leaf widgets (`text{markdown}`, `figure{ids, alts, justify, mask}`, `video{...}`, `button{label, href, variant}`, `list{tag, layout, sort, limit}`, `marquee{text, speed}`, `accordion{items[]}`, `progress{}`, `embed{url}`). Overrides are slot values; unset slots render macro defaults.
2. **Text as DSL.** Only `text.markdown` contains markdown, limited to inline formatting, links, lists, headings, code. It never contains image or widget syntax. Images beside prose are sibling `figure` entries in the enclosing `flow.blocks` array. Float left/right stays an attribute of the `figure` widget.
3. **Depth rule.** Each stored macro definition: max 3 container levels (e.g. section > row > col > leaf is the deepest allowed shape). Editor enforces: it shows depth, disallows a fourth level inside one macro, and offers "save inner part as its own macro" at that moment. Page-level expanded depth is unbounded. Expander does not enforce depth; it enforces only cycle safety.
4. **Macros as files.** Each macro is a stored JSON tree plus a declared field schema (label, type, default) driving inline fields. Example: `hero` fields are heading, text, background image id, 1–2 buttons; `cards-3` fields are three triples of image/title/link plus optional band title. Unset fields render defaults. Defaults-only files are curried macros.
5. **Editor.** Left palette of branded macros; click or drag inserts as one collapsed card. Card expands to inline fields (text inputs with rich text for `text` slots, image picker via existing upload, link picker for page/listing/URL). Advanced disclosure shows the inner row/col tree read-only with indent and color; "open as macro" jumps to macro editing. Duplicate button copies overrides. "Save selection as macro" prompts for name and creates the file. No JSON or fence editing in normal flow.
   Interaction, decided 2026-10-22: drag from the palette onto a drop target in the page (drop indicators show the landing slot); double-click (or Enter) on a palette item inserts at the focused slot without dragging. Click a block to select it and edit its values inline. Drag handles reorder blocks, retained from the legacy editor's figure reorder, including keyboard move and screen-reader position announcements. Any block may move to any compatible drop target anywhere on the page, across containers: a move relocates that block's JSON object in the tree and the page reflows. The editor enforces only the depth-3-per-macro rule and the cycle guard at drop time.
6. **Preview.** Same-tree render in both toggles. Desktop ~1200px and phone ~390px side-by-side or switched. Proves stacking without author action. Reuses `/admin/view/:slug` path; listings keep the decided placeholder offline.
7. **jbr.tcl/layout mapping (inspiration, not port).** Automatic naming becomes positional paths (author never types one). `row`/`col` plus `&` next-row becomes flex rows/cols. One-character macros (`@` label, `!` button) become palette macros. Global options (`-sticky`, weights, `-label.pady`) become theme tokens and gap scale, not per-page knobs. `layout.define`/`layout.macro` becomes macro files. Nesting arbitrarily deep in Tcl becomes depth-3-per-macro plus composition here, trading raw power for a non-breakable authoring ceiling.

## Left to the builder

- Exact JSON schema, macro library directory, and filename conventions, with migration of the five inventory patterns as fixtures.
- Field-schema shape for macro definitions and how image ids / listing tags validate.
- Precedence rule where both a macro default and a root-page default supply the same slot (e.g. thermometer goal).
- Cycle-detection error wording and where it surfaces in build log and editor.
- Editor stack details: JSON tree state vs TipTap only inside `text` fields, palette drag data, inline-field components, depth-meter UI copy, save-as-macro flow, preview iframe widths.
- CSS: flex/grid classes for row/col/grid, wave edge SVG, hero scrim for 4.5:1, reduced-motion handling, phone breakpoint value.
- Markdown-to-JSON migration script behavior for existing posts, including inline-figure mapping.
- Plan staging after this doc is approved.
