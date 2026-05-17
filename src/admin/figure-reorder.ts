// Figure image reorder: pure permute/hit-test helpers + delegated
// pointer/keyboard wiring. Spec:
// docs/superpowers/specs/2026-05-16-figure-reorder-design.md
// Reorder is one permutation applied in lockstep to the figure's
// three parallel arrays (ids ',', alts ',', captions '|').

import type { Editor } from '@tiptap/core';

/** Move arr[from] to index `to`. Returns a new array on a real move;
 *  returns the input array unchanged when from===to or either index is
 *  out of [0, len) (same no-op identity contract as reorderFigureCells,
 *  so callers can skip work on reference equality). Never mutates. */
export function moveItem<T>(arr: T[], from: number, to: number): T[] {
  const n = arr.length;
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return arr;
  const copy = arr.slice();
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item as T);
  return copy;
}

export interface FigureCellArrays {
  ids: string;
  alts: string;
  captions: string;
}

/** Split the three parallel arrays, move cell from→to in lockstep,
 *  re-pad alts/captions to ids length, rejoin. Returns the original
 *  object when the move is a no-op (so callers can skip the commit). */
export function reorderFigureCells(
  attrs: FigureCellArrays,
  from: number,
  to: number
): FigureCellArrays {
  const ids = attrs.ids.split(',').map((s) => s.trim());
  const n = ids.length;
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return attrs;
  const alts = attrs.alts.split(',').map((s) => s.trim());
  const captions = attrs.captions.split('|');
  while (alts.length < n) alts.push('');
  while (captions.length < n) captions.push('');
  alts.length = n;
  captions.length = n;
  return {
    ids: moveItem(ids, from, to).join(','),
    alts: moveItem(alts, from, to).join(','),
    captions: moveItem(captions, from, to).join('|')
  };
}

export interface CellRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Reading-order (row-major, left→right, top→bottom) insertion index
 *  for a pointer at (px,py) given each cell's viewport rect in DOM
 *  order. Works for ANY layout — single row, single column, wrapped
 *  grid, masonry — because it anchors on the nearest cell centre and
 *  then decides before/after by reading order, instead of projecting
 *  onto one fixed axis (the old 1-D scan only handled the first row).
 *  Result is in [0, rects.length]. */
export function dropIndexFor2D(rects: CellRect[], px: number, py: number): number {
  const n = rects.length;
  if (n === 0) return 0;
  let nearest = 0;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const r = rects[i] as CellRect;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const d = (px - cx) ** 2 + (py - cy) ** 2;
    if (d < best) {
      best = d;
      nearest = i;
    }
  }
  const r = rects[nearest] as CellRect;
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  // Below the anchor's row → after; above → before; same row → which
  // side of its centre the pointer is on.
  const after = py > cy + r.height / 2 ? true : py < cy - r.height / 2 ? false : px > cx;
  return Math.max(0, Math.min(n, after ? nearest + 1 : nearest));
}

const DRAG_THRESHOLD_PX = 8;
const EDGE_AUTOSCROLL_PX = 48;
const EDGE_SCROLL_STEP = 12;

/** Find the figure node position whose rendered DOM is `placeholder`.
 *  Same robust nodeDOM match the figure-delete path uses (posAtDOM is
 *  ambiguous on atoms). */
function figurePosFor(editor: Editor, placeholder: Element): number | null {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === 'figure' && editor.view.nodeDOM(pos) === placeholder) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

function commitReorder(editor: Editor, placeholder: Element, from: number, to: number): void {
  const pos = figurePosFor(editor, placeholder);
  if (pos === null) return;
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return;
  const next = reorderFigureCells(
    {
      ids: (node.attrs.ids as string | undefined) ?? '',
      alts: (node.attrs.alts as string | undefined) ?? '',
      captions: (node.attrs.captions as string | undefined) ?? ''
    },
    from,
    to
  );
  if (next.ids === ((node.attrs.ids as string | undefined) ?? '')) return; // no-op
  editor.commands.command(({ tr, dispatch }) => {
    if (dispatch) dispatch(tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...next }));
    return true;
  });
  // Announce via a JS-owned live region OUTSIDE ProseMirror's managed
  // DOM. The figure is a custom node whose renderHTML is re-run on
  // every transaction, so any text written into a node *inside* the
  // atom is wiped by the next re-render (which this setNodeMarkup, plus
  // the ensuing focus/selection change, trigger). A standalone region
  // on the document body is never touched by PM, so the message sticks.
  const total = next.ids.split(',').length;
  announce(editor, `Moved to position ${to + 1} of ${total}`);
}

function thumbsOf(placeholder: Element): HTMLImageElement[] {
  return Array.from(placeholder.querySelectorAll<HTMLImageElement>('img[data-cell-index]'));
}

// One shared, visually-hidden aria-live region per document, owned by
// this module and appended to <body> — deliberately NOT a node inside
// the figure (ProseMirror regenerates the figure's DOM on every
// transaction, which would wipe the announcement). `.rkr-multi-status`
// supplies the visually-hidden styling; `data-reorder-status` is the
// stable hook the e2e asserts on.
let liveRegion: HTMLElement | null = null;

function announce(editor: Editor, msg: string): void {
  const doc = (editor.view.dom as HTMLElement).ownerDocument;
  if (!liveRegion?.isConnected || liveRegion.ownerDocument !== doc) {
    liveRegion = doc.createElement('div');
    liveRegion.className = 'rkr-multi-status';
    liveRegion.setAttribute('data-reorder-status', '');
    liveRegion.setAttribute('aria-live', 'polite');
    doc.body.appendChild(liveRegion);
  }
  liveRegion.textContent = msg;
}

/** Install delegated reorder listeners on the editor DOM. Mirrors the
 *  existing delegated click handler in main.ts (the figure is a plain
 *  Node with no per-instance NodeView, so delegation is the only
 *  consistent attach point). Self-contained: a capture-phase click
 *  listener swallows the synthetic post-drag click so tap-to-edit in
 *  main.ts is untouched. */
export function wireFigureReorder(editor: Editor): void {
  const root = editor.view.dom as HTMLElement;
  let justDragged = false;
  // True only between a pointerdown that landed on a reorderable thumb
  // and the matching pointerup/cancel. dragstart is suppressed ONLY in
  // that window — so a press-drag elsewhere on the figure still starts
  // ProseMirror's whole-figure node-drag (the figure stays draggable).
  let reorderActive = false;

  root.addEventListener(
    'click',
    (ev) => {
      if (justDragged) {
        justDragged = false;
        ev.stopImmediatePropagation();
        ev.preventDefault();
      }
    },
    true // capture: runs before main.ts's bubble-phase click handler
  );

  // A real mouse press-drag on a thumb would otherwise start native
  // image drag-and-drop AND ProseMirror's node-drag (the figure node is
  // draggable:true) — either preempts the pointermove stream, so the
  // reorder silently never engages. Cancel dragstart at the source.
  // Capture phase + window so it beats PM's own dragstart handling.
  window.addEventListener(
    'dragstart',
    (ev) => {
      // Suppress dragstart ONLY during an in-progress thumb-reorder
      // gesture. Both native <img> DnD and ProseMirror's node-drag fire
      // dragstart on the placeholder DIV (not the <img>), so the target
      // can't disambiguate reorder-vs-figure-move — the pointerdown
      // origin can. Outside a reorder gesture we let dragstart through
      // so PM's whole-figure node-drag still works (figure draggable).
      if (!reorderActive) return;
      const t = ev.target as HTMLElement | null;
      if (t?.closest('.rkr-figure-placeholder')) ev.preventDefault();
    },
    true
  );

  root.addEventListener('pointerdown', (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target?.matches('img[data-cell-index]')) return;
    const placeholder = target.closest('.rkr-figure-placeholder');
    if (!placeholder) return;
    const thumbs = thumbsOf(placeholder);
    const from = thumbs.indexOf(target as HTMLImageElement);
    if (from < 0 || thumbs.length < 2) return;
    // This press is on a reorderable thumb: suppress dragstart for the
    // life of the gesture (cleared in cleanup) so native/PM DnD can't
    // eat the pointer stream. Presses elsewhere leave reorderActive
    // false → PM whole-figure node-drag still works.
    reorderActive = true;

    const startX = ev.clientX;
    const startY = ev.clientY;
    let dragging = false;
    let indicator: HTMLDivElement | null = null;
    let clone: HTMLElement | null = null;
    let dropIndex = from;
    let rafId = 0;

    const scrollContainer = (root.closest('#rkroll-admin-article') as HTMLElement | null) ?? root;

    const ensureIndicator = (): HTMLDivElement => {
      if (indicator) return indicator;
      const el = document.createElement('div');
      el.className = 'rkr-multi-drop-indicator';
      el.setAttribute('contenteditable', 'false');
      placeholder.querySelector('.rkr-multi-thumbs')?.appendChild(el);
      indicator = el;
      return el;
    };

    // Vertical insertion bar at the drop slot. Anchored on the specific
    // thumb at dropIndex (its own row), so it lands correctly in any
    // row of a wrapped grid; width/colour come from CSS so it can be
    // made boldly visible without touching JS.
    const positionIndicator = () => {
      const el = ensureIndicator();
      const atEnd = dropIndex >= thumbs.length;
      const ref = thumbs[atEnd ? thumbs.length - 1 : dropIndex];
      if (!ref) return;
      const r = ref.getBoundingClientRect();
      // offsetParent is null if the grid (or an ancestor) is display:none
      // or lacks a positioned ancestor. Bail rather than throw.
      const offsetEl = el.offsetParent as HTMLElement | null;
      if (!offsetEl) return;
      const pr = offsetEl.getBoundingClientRect();
      const x = (atEnd ? r.right : r.left) - pr.left;
      el.style.left = `${x}px`;
      el.style.top = `${r.top - pr.top}px`;
      el.style.height = `${r.height}px`;
    };

    let cloneDX = 0;
    let cloneDY = 0;
    const makeClone = () => {
      const r = target.getBoundingClientRect();
      const el = target.cloneNode(true) as HTMLElement;
      el.className = 'rkr-multi-drag-clone';
      el.removeAttribute('data-cell-index');
      el.removeAttribute('tabindex');
      el.style.width = `${r.width}px`;
      el.style.height = `${r.height}px`;
      document.body.appendChild(el);
      clone = el;
      cloneDX = startX - r.left;
      cloneDY = startY - r.top;
    };

    const autoscroll = () => {
      const sc = scrollContainer.getBoundingClientRect();
      if (lastY < sc.top + EDGE_AUTOSCROLL_PX) scrollContainer.scrollTop -= EDGE_SCROLL_STEP;
      else if (lastY > sc.bottom - EDGE_AUTOSCROLL_PX)
        scrollContainer.scrollTop += EDGE_SCROLL_STEP;
      rafId = requestAnimationFrame(autoscroll);
    };

    let lastY = startY;

    const onMove = (e: PointerEvent) => {
      lastY = e.clientY;
      if (!dragging) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD_PX) return;
        dragging = true;
        target.setPointerCapture(e.pointerId);
        target.classList.add('is-dragging');
        makeClone();
        rafId = requestAnimationFrame(autoscroll);
      }
      if (clone) {
        clone.style.left = `${e.clientX - cloneDX}px`;
        clone.style.top = `${e.clientY - cloneDY}px`;
      }
      const rects = thumbs.map((t) => {
        const r = t.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      });
      dropIndex = dropIndexFor2D(rects, e.clientX, e.clientY);
      positionIndicator();
    };

    const cleanup = () => {
      // Use window + capture so removal is symmetric with the add below.
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onCancel, true);
      if (rafId) cancelAnimationFrame(rafId);
      target.classList.remove('is-dragging');
      indicator?.remove();
      clone?.remove();
      // End of gesture: let dragstart through again so PM node-drag works.
      reorderActive = false;
    };

    const onUp = () => {
      const wasDragging = dragging;
      let to = dropIndex > from ? dropIndex - 1 : dropIndex;
      to = Math.max(0, Math.min(thumbs.length - 1, to));
      cleanup();
      if (wasDragging) {
        justDragged = true; // swallow the trailing click
        if (to !== from) {
          // commitReorder announces the new position via the live
          // status node after the re-render (placeholder is stale here).
          commitReorder(editor, placeholder, from, to);
        }
      }
    };

    const onCancel = () => cleanup();

    // Capture phase on window so ProseMirror's own pointermove / pointerup
    // handlers (which may call stopPropagation on the root element) cannot
    // prevent these from firing. After setPointerCapture the browser directs
    // all subsequent events to the capturing element; bubbling then carries
    // them up through the DOM. A capture-phase window listener sees them
    // before any stopPropagation call on a descendant can block them.
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
  });

  root.addEventListener('keydown', (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target?.matches('img[data-cell-index]')) return;
    // Thumbs carry role="button" + tabindex=0, so keyboard users
    // expect Enter/Space to activate. Activation = the same per-cell
    // edit a tap opens: synthesize a click (justDragged is false here,
    // so the capture-phase suppressor lets it through to main.ts's
    // delegated click→edit handler). Keyboard parity with tap-to-edit,
    // and it closes the role="button"-without-activation a11y gap.
    if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
      ev.preventDefault();
      (target as HTMLElement).click();
      return;
    }
    const dir =
      ev.key === 'ArrowLeft' || ev.key === 'ArrowUp'
        ? -1
        : ev.key === 'ArrowRight' || ev.key === 'ArrowDown'
          ? 1
          : 0;
    if (dir === 0) return;
    const placeholder = target.closest('.rkr-figure-placeholder');
    if (!placeholder) return;
    const thumbs = thumbsOf(placeholder);
    const from = thumbs.indexOf(target as HTMLImageElement);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= thumbs.length) return;
    ev.preventDefault();
    // Capture the figure's doc position BEFORE committing the reorder,
    // while `placeholder` still matches what nodeDOM returns.
    const figPos = figurePosFor(editor, placeholder);
    commitReorder(editor, placeholder, from, to);
    // ProseMirror replaces the atom's DOM on setNodeMarkup; both
    // `placeholder` and any pre-captured thumb refs are stale the
    // instant the transaction commits. Re-resolve via nodeDOM after
    // the browser has settled the re-render (one rAF).
    requestAnimationFrame(() => {
      if (figPos === null) return;
      const newPlaceholder = editor.view.nodeDOM(figPos) as Element | null;
      if (!newPlaceholder) return;
      const moved = thumbsOf(newPlaceholder)[to];
      moved?.focus();
    });
    // commitReorder handles the aria-live announcement after re-render.
  });
}
