# Editor and figures: clearing the deferred items

Clearing pass over the "Editor & figures" section of `docs/DEFERRED.md`.
Each item gets the smallest correct fix; one stays deferred.

## Outcome per item

| item | decision |
|---|---|
| `parseHTML` drops figure attrs | fix |
| container-directive galleries for per-image captions | delete the entry; `captions="a\|b"` already does this |
| cross-figure image move | implement, pointer only |
| per-instance crops | stays deferred; touches sidecar ops, render, cache keys and the cropper |

## 1. `parseHTML` reads attrs back

`src/admin/figure-node.ts` `parseHTML` returns `{ tag: 'div.rkr-figure-placeholder' }`
with no `getAttrs`, so pasting rendered editor HTML yields a figure with
all-default attrs and empty `ids`. `renderHTML` already writes every
`FigureAttrs` key onto the wrapper div through `mergeAttributes`.

Change: add `getAttrs(dom)` that reads each `FigureAttrs` key from the
element's attributes, falling back to `FIGURE_DEFAULTS` when missing,
and parses `timer` to a number. Apply the same shape to
`src/admin/video-node.ts`.

Test (`test/admin/figure-node-parse.test.ts`): build a figure node with
non-default attrs, render through the schema to DOM, parse back with
`DOMParser.fromSchema`, assert attrs equal. Same for video.

## 2. Cross-figure image move

`src/admin/figure-reorder.ts`. Only the pointer gesture changes.

**Source rule unchanged.** A gesture starts only on a figure with two
or more thumbs. A source therefore never empties, so there is no
source-deletion path, and press-drag on a single-image figure still
moves the whole figure through ProseMirror node drag.

**Target.** Any figure in the editor, including a single-image one.
On each `pointermove`, after the threshold, resolve
`document.elementFromPoint(x, y)?.closest('.rkr-figure-placeholder')`
restricted to descendants of the editor root. The drag clone has
`pointer-events: none`, so it never shadows the hit-test.

- Target is the source or null: existing within-figure behaviour.
- Target is another figure: `dropIndex = dropIndexFor2D(targetThumbs, x, y)`
  over that figure's thumbs, and the indicator is moved into that
  figure's `.rkr-multi-thumbs`. The indicator anchors on the target's
  thumb at `dropIndex`, or the last thumb's right edge when at end.

**Commit.** New pure helper:

```ts
moveCellBetween(src: FigureCellArrays, dst: FigureCellArrays, from: number, to: number)
  : { src: FigureCellArrays; dst: FigureCellArrays }
```

Removes cell `from` of `src` and inserts it at `to` in `dst` (clamped to
`[0, dst.length]`), padding `alts` and `captions` to `ids` length on
both sides as `reorderFigureCells` does. Returns the inputs unchanged on
an out-of-range `from`.

`commitMove` resolves both figure positions with `figurePosFor` before
dispatching, then applies two `setNodeMarkup` calls in one transaction.
An atom's size does not change, so the second position stays valid
after the first call. One undo step.

`matrix` on either figure is untouched. The spec's over-allocated and
overflow rules already define how a diptych renders with one or three
images.

**Announcement.** `Moved to position K of M in the next figure` or
`… in the previous figure`, chosen by document order of the two
positions.

**Keyboard.** Stays within-figure. Not changed.

**Tests.**

- Unit (`test/admin/figure-reorder.test.ts`): `moveCellBetween` moves
  the id with its alt and caption, pads short arrays, clamps `to`, and
  is identity on bad `from`.
- E2E (`test/e2e/figure-reorder.spec.ts`): build a two-image figure,
  insert a paragraph, build a second single-image figure, drag thumb 0
  of the first past the second figure's thumb with real mouse input,
  assert the first has one id and the second has two in the expected
  order, save, reopen, assert persistence.

## 3. Docs

- `docs/spec.md` §8 "Reordering images within a figure": replace the
  last sentence with the cross-figure behaviour (drag between figures,
  target may be single-image, keyboard is within-figure).
- `docs/implementation.md` §8a: replace the closing paragraph with the
  target hit-test and two-node transaction notes.
- `docs/DEFERRED.md`: delete the parseHTML, container-directive and
  cross-figure lines. The crops line stays.
