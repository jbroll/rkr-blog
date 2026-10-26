# Grid layout for block pages

Replaces the four container types (`section`, `row`, `col`, `flow`) with
one, `grid`, and makes placement rules explicit so the editor can show
where a block may go and the saved tree always renders something
defined. Amends `docs/spec.md §8a`.

## Problems

- Four container types differ only in direction (row versus column) and
  looks (section). Authors cannot tell which to use.
- Almost any block may go anywhere. A drag shows no legal slots, and
  invalid states save: a macro instance naming a macro that does not
  exist (from a dropped image URL), a figure with no images.
- Over the gap between blocks a drop targets the surrounding container's
  edge, which on a migrated post is the top of the page.

## The grid

```json
{ "type": "grid",
  "slots": { "cols": 3, "min": "medium", "widths": "2 1", "band": true,
             "theme": "dark", "edge": "wave" },
  "children": [ ... ] }
```

| Slot | Values | Default | Effect |
|---|---|---|---|
| `cols` | integer 1–6 | 1 | Cells side by side when there is room. Children fill cells in reading order and wrap, so six children at `cols: 3` make two rows. |
| `min` | `narrow` (10rem), `medium` (16rem), `wide` (24rem) | `medium` | Narrowest cell. A grid too narrow for `cols` cells of this width shows fewer columns, down to one. |
| `widths` | space-separated positive numbers, one per column | equal | Column ratio, e.g. `2 1`. Ignored unless it has exactly `cols` entries. With `widths`, the grid goes straight to one column when it is too narrow for every column at `min`. |
| `band` | boolean | false | Full page width with the section padding; `theme` and `edge` apply only with `band`. |
| `theme` | the existing section themes | `light` | Band background. |
| `edge` | `straight`, `wave` | `straight` | Band bottom edge. |

- Collapse depends on the grid's own width, not the screen's, so a grid
  nested in a narrow cell collapses too. On a phone every grid ends up
  one column and the page scrolls.
- An empty grid is valid. Readers see nothing; the editor shows a
  placeholder, "Empty grid: drag blocks here", which takes drops.
- The page body is itself a one-column stack. It is not stored as a
  grid.

## Names authors see

The palette's Layout group keeps three presets, all inserting a `grid`:

| Palette entry | Inserts | Toolbar label |
|---|---|---|
| Row | `cols: 2`, empty | Row (2 columns) |
| Column | `cols: 1` | Column |
| Section | `cols: 1, band: true` | Section |

The toolbar label follows the slots, not how the grid was inserted:
`band` reads Section, `cols` 1 reads Column, otherwise Row (N columns).

`row`, `col`, `flow` and `section` remain valid in macro files and in
existing page files as shorthand. The parser expands them on read:

| Shorthand | Grid |
|---|---|
| `section` (`theme`, `edge`) | `band: true`, same `theme` and `edge`, `cols: 1` |
| `row` | `cols` = number of children, capped at 6 |
| `col`, `flow` (`children` or `blocks`) | `cols: 1` |

A page is saved with `grid` only. Seed macros keep their shorthand.

## Hard rules

Every saved tree renders something defined. The client never builds a
tree that breaks these, and the save route rejects one with `400`,
naming the first problem and its block path.

1. Block types come from the closed list: `grid`, the leaves of §8a,
   and `macro`. Shorthand is expanded before this check.
2. A macro instance names a macro in the site's library. (The render
   endpoint keeps rendering a comment for an unknown macro so a page
   whose macro file was deleted still opens.)
3. A `figure` has at least one image id; a `video` has an id. Choosing
   Image or Video in the palette opens the picker first and inserts the
   block only when something is picked; Cancel inserts nothing.
4. Leaves and macro instances have no children.
5. At most three grid levels nest, counted from the page body (a macro's
   own grids count inside its definition, as today).
6. `cols`, `min`, `widths`, `band`, `theme` and `edge` hold the values in
   the table above.

Nothing removes or unwraps a grid automatically. An empty grid or a
one-cell grid stays until the author deletes it.

## Soft rules (guidance, not errors)

- A `band` grid is offered only at page level: the palette's Section
  inserts at page level, and drag slots for a band grid appear only
  between page-level blocks.
- A one-column grid directly inside another one-column grid adds
  nothing. Drags never offer that slot, and the toolbar's wrap actions
  never create it. Existing trees that have it render and save.

## Dragging

Drops never create structure. A drop places the block into a grid that
already exists, or into the page body.

- The target is the innermost grid under the pointer (the page body when
  over none). Its slots are the gaps between its cells in reading order,
  plus before the first and after the last.
- The active slot is the one nearest the pointer. Its marker is a
  vertical bar when the cells on either side sit side by side, and a
  horizontal line when they are stacked, read from the live layout so
  it stays right after the grid wraps.
- Over an empty grid the only slot is inside it; its placeholder
  highlights.
- A slot is shown only when the drop is legal under the hard and soft
  rules for the dragged block. Where none is legal the cursor shows the
  drop is refused.
- Only palette entries and the toolbar's drag handle start a drop. Drag
  text from elsewhere (a URL, selected words) inserts nothing, and the
  page's own images, links and videos cannot be dragged in Edit mode.
- The dragged block follows the pointer as a copy at most 320 × 240 px.

Structure changes only through deliberate actions:

- The palette's Row, Column and Section.
- The block toolbar: **Wrap in row** (a `cols: 2` grid holding the
  block; the free column takes drops beside it), **Wrap in column** (a
  `cols: 1` grid holding the block), and on a grid **Unwrap** (its
  children take its place in the parent; the grid is deleted). Wrap is
  refused at the depth limit. Undo is out of scope; Unwrap after Wrap
  restores the tree.

## Reading versus saving

Validation is split so a page on disk always opens:

- **Reading** (page files, macro files, the render endpoint) expands
  shorthand and checks structure only: known types, children only on
  grids, macro names are strings. Out-of-range grid slots are clamped
  at render (`cols` to 1–6, unknown `min` to `medium`, a `widths` with
  the wrong count ignored). An unknown macro renders a comment.
- **Saving** applies every hard rule. A page that already breaks one
  (a macro whose file was deleted, an empty figure from before this
  change) opens and renders; the editor marks the offending block
  ("This block can't be saved: the macro hero no longer exists. Delete
  it to save.") and the save is refused with that message until the
  author fixes it.

## Configure a grid

Configure on a grid opens the shared dialog:

- Columns: 1–6.
- Narrowest cell: Narrow, Medium, Wide.
- Column widths: Equal, or a ratio field shown when Columns is 2–4,
  validated to `cols` positive numbers.
- Full-width band: checkbox; when on, Background (the theme list) and
  Bottom edge (Straight, Wave).

## Migrated posts

`blocks-migrate` writes a post's blocks directly into the page body, with
no wrapping container. A figure that opens the body is the hero, as now.
For trees written before this change, a figure that opens a leading
one-column grid is the hero too.

`blocks-migrate --all --force` re-converts posts over their existing
JSON twins. It is how the dev site picks up this change; it discards
edits made in the editor to those twins.

## Out of scope

- Cells that span columns or rows. Nest a grid instead.
- Merging figures: a row of single-image figures and one figure with
  several images look alike. Both stay allowed; no prompt to merge.
- Undo.
- Editing macro definitions in the editor.
