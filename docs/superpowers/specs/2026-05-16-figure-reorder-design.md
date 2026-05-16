# Figure image reorder — design

**Source.** User request, 2026-05-16. Promotes `docs/DEFERRED.md`
"Drag-and-drop image reordering in the figure editor".

**Goal.** Let an author reorder the images within a multi-image figure
(gallery / carousel / justified / masonry / diptych / triptych) by
direct manipulation, on tablet first. No more hand-editing `ids=`.

## Scope

**In (v1):** reorder images *within a single figure*.

**Out (documented fast-follow):** moving an image *between* figures.
That adds a two-node transaction, empty-source-figure deletion, and a
fixed-slot capacity rule for diptych/triptych — see "Fast-follow".

## Interaction model

The figure placeholder already renders a thumb grid:
`.rkr-multi-thumbs > img.rkr-image.rkr-multi-thumb[data-id][data-cell-index]`
(see `src/admin/figure-node.ts`). Today a single click on a thumb opens
per-cell editing via the delegated `click` handler in `src/admin/main.ts`
(`img[data-cell-index]` → sets `activeCellIndex` → populates the edit
panel). That behavior is preserved unchanged.

Reorder is **purely additive** — a different gesture on the same thumb:

- **Tap / click a thumb (no movement)** → existing per-cell edit.
  Unchanged.
- **Drag a thumb** (Pointer Events: touch / pen / mouse, one code path)
  → reorder within the figure.
- **Focus a thumb + Arrow keys** → same reorder, for keyboard / a11y.

Click vs. drag is disambiguated by a movement threshold; a real drag
suppresses the trailing synthetic `click` so edit never co-fires.

### Pointer drag (primary, tablet-first)

- `pointerdown` on a thumb records the start point and pointer id.
- On the first `pointermove` exceeding the threshold
  (`DRAG_THRESHOLD_PX = 8`; generous enough for imprecise touch, tight
  enough that an intentional tap never trips it), the drag begins:
  `thumb.setPointerCapture(e.pointerId)`, mark a `dragging` flag.
- The thumb grid gets CSS `touch-action: none` so a finger-drag that
  starts on a thumb is not consumed by page scroll. Scrolling the page
  is still possible by starting the gesture off a thumb.
- During the drag, `document.elementFromPoint(clientX, clientY)`
  resolves the thumb under the pointer; the insertion index is "before"
  or "after" that thumb by its horizontal/vertical midpoint. An
  insertion indicator (a 2px rule between thumbs) shows the target gap.
- If the pointer is within `EDGE_AUTOSCROLL_PX = 48` of the editor
  scroll container's top/bottom edge, scroll it by a fixed step per
  animation frame (long posts on a small screen).
- `pointerup` → if the index changed, commit the reorder (below) and
  set a `justDragged` flag consumed by the delegated click handler so
  the synthetic click is swallowed. `pointercancel` aborts: clear the
  indicator and state, no commit.

### Keyboard (a11y, ships in v1)

Each thumb gets `tabindex="0"` and `role="button"` plus an
`aria-label` ("Image N of M; use arrow keys to reorder"). The grid
gets an `aria-live="polite"` status node.

- `ArrowLeft` / `ArrowUp` → move the focused thumb one position earlier.
- `ArrowRight` / `ArrowDown` → one position later.
- No-ops at the ends. Order is one-dimensional (the `ids` array is
  linear regardless of the visual layout), so all four arrows map to
  prev/next; left/up = earlier, right/down = later.
- After the move, focus follows the moved thumb and the live region
  announces "Moved to position K of M".

This is the same permute + commit as the drag, triggered by `keydown`
instead of `pointerup`. The `aria-live` node is required for the
keyboard path and is therefore not extra cost.

## Data model & commit

A figure node carries three **parallel arrays** (`src/admin/figure-node.ts`
`FigureAttrs`): `ids` (comma-sep), `alts` (comma-sep), `captions`
(pipe-sep). A reorder is a single permutation applied identically to
all three.

**Pure core (`src/admin/figure-reorder.ts`):**

```ts
/** Move arr[from] to index `to`, returning a new array. Clamps and
 *  no-ops when from===to or indices are out of range. */
export function moveItem<T>(arr: T[], from: number, to: number): T[];

export interface FigureCellArrays { ids: string; alts: string; captions: string; }

/** Split the three parallel arrays, move cell `from`→`to` in lockstep,
 *  re-pad alts/captions to ids length, rejoin. Returns the original
 *  strings unchanged when the move is a no-op. */
export function reorderFigureCells(
  attrs: FigureCellArrays, from: number, to: number
): FigureCellArrays;
```

These are pure and unit-tested. (`src/admin/**` is excluded from the
c8 gate, but the tests still run under `node --test` and assert
correctness — same as other admin pure helpers.)

**Commit (DOM side, in `figure-reorder.ts`'s wiring, called from
`main.ts`):** locate the figure node by the robust pattern the delete
path already uses — walk `editor.state.doc.descendants` and match
`editor.view.nodeDOM(pos) === placeholder` (NOT the fragile
ids-string match). Apply one history-eligible transaction:
`tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...reordered })`.
One transaction → one undo step per reorder.

## File structure

- **New `src/admin/figure-reorder.ts`** — (a) the pure helpers above;
  (b) `wireFigureReorder(editor)` that installs **delegated**
  `pointerdown` + `keydown` listeners on `editor.view.dom` (mirroring
  the existing delegated `click` handler in `main.ts` — the figure is a
  plain Node with no per-instance NodeView, so delegation is the only
  consistent attach point). It filters to `img[data-cell-index]`,
  resolves the placeholder via `target.closest('.rkr-figure-placeholder')`,
  runs the drag state machine + insertion indicator + edge auto-scroll,
  and performs the commit. It exposes a `consumeJustDragged()` predicate
  so the click handler can swallow the post-drag synthetic click.
  Keeping this out of `main.ts` is required: `main.ts` is at the
  500-line cap and was split before for the same reason.
- **`src/admin/main.ts`** — call `wireFigureReorder(editor)` once where
  the other delegated editor listeners are installed; have the delegated
  `click` handler early-return when `consumeJustDragged()` is true
  (suppress post-drag click).
- **`src/templates/admin-styles.ts`** — add: `.rkr-multi-thumbs{touch-action:none}`,
  `.rkr-multi-thumb[tabindex]` focus ring, `.rkr-multi-thumb.is-dragging`
  (lifted/translucent), `.rkr-multi-drop-indicator` (2px insertion rule).
- **`src/admin/figure-node.ts`** — thumbs render with `tabindex="0"`,
  `role="button"`, and the reorder `aria-label`; add the grid's
  `aria-live` status node.
- **Tests:** `test/admin/figure-reorder.test.ts` (pure helpers —
  `moveItem` edge cases, `reorderFigureCells` lockstep + re-pad +
  no-op); `test/e2e/figure-reorder.spec.ts` (Playwright: drag a thumb
  to a new slot → order changes & persists through save; a stationary
  click still opens per-cell edit; keyboard Arrow reorders a focused
  thumb).

## Error / edge handling

- `from === to`, single-image figure, or out-of-range index → no-op
  (no transaction, no undo entry).
- `alts` / `captions` shorter than `ids` (legacy data) → `reorderFigureCells`
  pads to `ids` length before permuting so slots stay aligned (mirrors
  the existing cell-delete re-pad at `main.ts` ~419-420).
- `pointercancel` / blur mid-drag → abort cleanly, no commit.
- Drag distance below threshold → treated as a tap (edit), not a
  reorder. Correct behavior for an accidental twitch.
- Reorder is layout-agnostic: diptych/triptych just swap slot order;
  the slot count is unchanged, so no capacity rule is needed in v1.

## Testing strategy

- **Unit (`node --test`):** the pure helpers — the reorder logic's
  correctness lives here and is fully covered without a DOM.
- **e2e (Playwright):** the pointer/keyboard wiring and the
  ProseMirror commit — drag reorder persists across save; tap still
  edits; keyboard reorder works. Tracked by the existing e2e coverage
  ratchet.

## Fast-follow (out of scope, documented)

Cross-figure move reuses this drag substrate. New work it requires,
to be specced separately: hit-testing across figures, a single PM
transaction patching *two* nodes (`setNodeMarkup` on source + target),
deleting an emptied source figure (today's code leaves `ids=''`), and
a fixed-slot capacity rule for diptych (2) / triptych (3) drop targets.
This spec deliberately does not design those.
