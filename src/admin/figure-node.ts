// Custom TipTap figure node — the only image-bearing node type in the
// editor. Replaces the legacy ImageNode + GalleryNode/CarouselNode/
// DiptychNode/TriptychNode that used to cover the same surface (spec.md
// §9). Renders to <div.rkr-figure-placeholder> in the editor; the wire
// format is `::figure{ids=… alts=… …}` after serialization.
//
// Attribute layout mirrors prose-markdown.ts emitFigure / parseFigure
// so the wire format is single-source-of-truth. Toolbar / attribute
// panel keeps a per-shape UX abstraction (image / gallery / carousel /
// diptych / triptych = different defaults + different visible inputs)
// but the on-disk node is always `figure`.

import { mergeAttributes, Node } from '@tiptap/core';

import { iconSpec } from '../templates/icons.ts';

export interface FigureAttrs {
  ids: string;
  /** Comma-separated parallel array of alts. */
  alts: string;
  /** Pipe-separated parallel array of per-image captions. */
  captions: string;
  /** Block-level caption (single, applies to whole figure). */
  caption: string;
  /** Matrix spec — `NxM` grid, or `justified[:H]`, or `masonry[:N]`. */
  matrix: string;
  /** center | left | right | full | bleed | inline */
  justify: string;
  /** CSS-ready width; e.g. "60%" or "400px". Empty = use justify default. */
  width: string;
  /** "W:H" cell aspect; empty = derive from first image. */
  aspect: string;
  /** cover | contain. Default cover. */
  fit: string;
  /** Carousel autoplay seconds (0 = manual). */
  timer: number;
}

const FIGURE_DEFAULTS: FigureAttrs = {
  ids: '',
  alts: '',
  captions: '',
  caption: '',
  matrix: '',
  justify: 'center',
  width: '',
  aspect: '',
  fit: 'cover',
  timer: 0
};

export const FigureNode = Node.create({
  name: 'figure',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return Object.fromEntries(Object.entries(FIGURE_DEFAULTS).map(([k, v]) => [k, { default: v }]));
  },
  parseHTML() {
    return [{ tag: 'div.rkr-figure-placeholder' }];
  },
  renderHTML({ HTMLAttributes }) {
    const attrs = HTMLAttributes as Partial<FigureAttrs>;
    const idList = (attrs.ids ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // Each thumb carries data-id + data-cell-index so main.ts's
    // delegated click handler can identify which cell the user picked
    // (per-cell editing for multi-image figures), and the rkr-image
    // class lets canvas-loaders' setEditorImageSrc find this <img> when
    // refreshing a per-cell preview after a local op.
    const thumbs: unknown[] = idList.map((id, i) => [
      'img',
      {
        src: `/admin/preview/${id}`,
        alt: '',
        class: 'rkr-image rkr-multi-thumb',
        'data-id': id,
        'data-cell-index': String(i)
      }
    ]);
    // The "+" affordance sits BELOW the thumb grid (not as a grid
    // cell) so the figure's editable click-area is the images
    // themselves, not an empty slot at the article's geometric
    // centre. main.ts's delegated click handler routes
    // [data-add-image] clicks to the source picker in append mode.
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        class: 'rkr-multi rkr-figure-placeholder',
        'data-kind': 'figure',
        'data-matrix': attrs.matrix ?? '',
        'data-count': String(idList.length),
        // Take the placeholder out of the editing context: CSS
        // user-select: none is the primary defense, but inside a
        // parent contenteditable="true" Webkit still pops the OS
        // cut/copy/paste menu on long-press of whitespace between
        // thumbs. contenteditable="false" on the node wrapper makes
        // the placeholder non-editable, killing that flow.
        contenteditable: 'false'
      }),
      ['div', { class: 'rkr-multi-thumbs', contenteditable: 'false' }, ...thumbs],
      [
        'div',
        { class: 'rkr-multi-actions', contenteditable: 'false' },
        [
          'button',
          {
            type: 'button',
            class: 'rkr-multi-add',
            'data-add-image': 'true',
            'aria-label': 'Add image to figure',
            title: 'Add image'
          },
          iconSpec('imagePlus', 16)
        ],
        [
          'button',
          {
            type: 'button',
            class: 'rkr-multi-config',
            'data-figure-config': 'true',
            'aria-label': 'Configure figure',
            title: 'Configure figure'
          },
          iconSpec('settings', 16)
        ],
        // Destructive at the bottom of the stack so an author
        // reaching for the safe affordances above can't graze it.
        [
          'button',
          {
            type: 'button',
            class: 'rkr-multi-delete',
            'data-figure-delete': 'true',
            'aria-label': 'Remove figure',
            title: 'Remove figure'
          },
          iconSpec('trash2', 16)
        ]
      ],
      // contenteditable="false" on every inner div as well as the
      // wrapper. Firefox Android's contenteditable inheritance is
      // patchy on touch — the OS cut/copy/paste action bar pops on
      // scroll when the touch lands on placeholder whitespace (CSS
      // gap between thumbs / actions / caption). Setting the bit
      // explicitly at every structural layer closes that inheritance
      // hole; the figure stays a normal selectable atom otherwise.
      // attrs.caption is rendered as a TEXT child of the div (3rd
      // tuple entry is a string), which TipTap treats as a text
      // node — no innerHTML construction, so the browser HTML-
      // escapes the value on its own. Don't change to string-
      // building HTML without re-adding explicit escaping.
      ...(attrs.caption
        ? [['div', { class: 'rkr-multi-caption', contenteditable: 'false' }, attrs.caption]]
        : [])
    ];
  }
});
