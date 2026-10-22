# Reusable blocks with nesting — design

Intent: let a non-technical editor assemble rich pages from branded, reusable pieces without hand-placing elements or thinking about phones, and without the Squarespace tedium of rebuilding the same band on every page.

Why now: the page-design inventory (`docs/proposal-page-design.md`) found 445 sections and repeated hand-copied card sets (board grid on `/about`, home carousel, three-card bands and Member-Owner of the Month on `/news`, five collection grids). Positioning and media-size adaptation in Squarespace are near impossible, and reusable branded blocks today require manual duplication (thermometer figures disagree: $747,485 vs $429,085). This design is the editing model that makes the page-design proposal authorable.

## Goals

- Pages are trees of logical blocks: one themed `section` wrapper, generic `row` (side-by-side) and `col` (stacked) containers, and leaves (prose, `::figure`, `::list`, button, marquee, accordion, progress, embed).
- Specialized bands (hero, split, 3-cards, logo wall, newsletter band, event band) are macros: prebuilt trees of row/col plus leaves with branded defaults. Insert, override a few fields, done.
- Parameters with fallback give linked behavior with no link concept: unset follows the macro default, set stays local. Changing a default flows to every use that left it unset on the next build.
- Nesting via composition: each macro definition is at most depth 3 (containers counted). A page reaches any depth by stacking macros and rows/cols. A detail macro may be complex inside but presents as one block with a few fields.
- Responsive by construction: divs plus flexbox/grid, split/columns stack under ~720px. No per-device adjustments, no pixel placement.
- Editor hides text: palette plus inline fields, duplicate and save-as-macro, depth shown visually, desktop/phone preview toggle proving adaptation.

## Non-goals

- No free positioning (no Fluid Engine drag-to-place).
- No per-page custom CSS or colors; themes own tokens per `docs/theming.md` contract.
- No versioned macro history or diff UI in v1; git history of macro files is enough.
- No live multi-user editing.

## Anti-goals

- Failing the static build because an author nested too deep. Depth guidance belongs in the editor, not as a build error.
- Exposing directive fences, ids, or hex image ids to authors.
- Reintroducing two modes (linked vs detached) with badges and link management. Rejected in favor of defaults-plus-overrides.

## Constraints

- Follows `docs/proposal-page-design.md` §2–§5 block inventory; does not change its decisions (system fonts, no HubSpot, placeholder listing preview offline).
- Container directives already parse (`containerDirective` in `src/lib/content.ts`); TipTap container editing is the new work (same as backlog group 4 container item).
- Rendering is server/build HTML plus small JS only where needed (carousel, accordion single-open, marquee pause on reduced motion). No new runtime deps assumed; builder picks.
- Macro expansion must detect cycles (macro using itself directly or transitively) and render a comment instead of looping.
- Settings-held singles (fundraising goal/raised, logo, announcement, menu/CTA/social/footer) stay in `config/site.json` per site-chrome plan; macros reference them, never copy them.

## Decided: the how

1. **Model.** `section{theme, edge, bg}` contains `row`/`col` contains leaves or nested `row`/`col` or a macro instance. Macro instance is `::name{overrides}` expanded at build to its stored tree with overrides applied. Overrides are ordinary attributes (titles, texts, image ids, hrefs, tag/limit for listings).
2. **Depth rule.** Each stored macro definition: max 3 container levels (e.g. section > row > col > leaf is the deepest allowed shape). Editor enforces: it shows depth, disallows a fourth level inside one macro, and offers "save inner part as its own macro" at that moment. Page-level expanded depth is unbounded. Expander does not enforce depth; it enforces only cycle safety.
3. **Macros as files.** Each macro is a stored markdown fragment with a declared field schema (label, type, default) driving inline fields. Example: `hero` fields are heading, text, background image id, 1–2 buttons; `cards-3` fields are three triples of image/title/link plus optional band title. Unset fields render defaults.
4. **Editor.** Left palette of branded macros; click or drag inserts as one collapsed card. Card expands to inline fields (text inputs, image picker via existing upload, link picker for page/listing/URL). Advanced disclosure shows the inner row/col tree read-only with indent and color; "open as macro" jumps to macro editing. Duplicate button copies overrides. "Save selection as macro" prompts for name and creates the file. No fence editing in normal flow.
5. **Preview.** Same-tree render in both toggles. Desktop ~1200px and phone ~390px side-by-side or switched. Proves stacking without author action. Reuses `/admin/view/:slug` path; listings keep the decided placeholder offline.
6. **jbr.tcl/layout mapping (inspiration, not port).** Automatic naming becomes content-addressed or positional ids (author never types one). `row`/`col` plus `&` next-row becomes flex rows/cols. One-character macros (`@` label, `!` button) become palette macros. Global options (`-sticky`, weights, `-label.pady`) become theme tokens and gap scale, not per-page knobs. `layout.define`/`layout.macro` becomes macro files. Nesting arbitrarily deep in Tcl becomes depth-3-per-macro plus composition here, trading raw power for a non-breakable authoring ceiling.

## Left to the builder

- Exact directive attribute names and macro file location/format (site-root library vs content dir), with migration of the five inventory patterns as fixtures.
- Field-schema shape for macro definitions and how image ids / listing tags validate.
- Cycle-detection error wording and where it surfaces in build log and editor.
- Editor stack details: TipTap container nodes, palette drag data, inline-field components, depth-meter UI copy, save-as-macro flow, preview iframe widths.
- CSS: flex/grid classes for row/col/grid, wave edge SVG, hero scrim for 4.5:1, reduced-motion handling, phone breakpoint value.
- Plan staging after this doc is approved.
