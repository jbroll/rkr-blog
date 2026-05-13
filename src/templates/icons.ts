// Shared SVG icon set, sourced from Lucide (https://lucide.dev/,
// MIT licence). The original Feather icons were licenced MIT by
// Cole Bemis; Lucide is the maintained fork by the same project.
// SPDX-License-Identifier: ISC AND MIT
//
// Why an in-tree copy instead of an npm dependency:
//   1. We need ~7 icons total; pulling in `lucide`'s ~1700 SVGs and
//      a tree-shaking story is far more weight than the inlined
//      paths cost on their own.
//   2. The renders happen in server templates (post.ts, layout.ts,
//      admin.ts via toolbar.ts) — they must produce HTML strings,
//      not React/Vue components. The npm package's surface is
//      component-shaped.
//   3. Pasting the paths means we never have to think about icon
//      bundling, tree-shaking config, or SSR-only entry points.
//
// All paths are 24x24 viewBox, fill='none', stroke='currentColor',
// stroke-width=2, rounded caps + joins — the Lucide house style.
// Callers pass a size (default 24) that gets stamped onto the
// width / height attributes; viewBox stays fixed so the geometry
// stays proportional.
//
// Two output forms share the same path data:
//   - icon(name, size) → an HTML string for server-rendered
//     templates (post.ts, layout.ts, etc.).
//   - iconSpec(name, size) → a ProseMirror DOMOutputSpec tuple for
//     TipTap renderHTML callsites (figure-node.ts). The tag is
//     namespaced ("http://www.w3.org/2000/svg svg") so ProseMirror's
//     DOMSerializer creates the element via createElementNS.

type ChildSpec = readonly [string, Record<string, string>];

const PATHS = {
  // <https://lucide.dev/icons/link>
  link: [
    ['path', { d: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71' }],
    ['path', { d: 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71' }]
  ],
  // <https://lucide.dev/icons/image-plus>
  imagePlus: [
    ['path', { d: 'M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7' }],
    ['path', { d: 'M16 5h6' }],
    ['path', { d: 'M19 2v6' }],
    ['circle', { cx: '9', cy: '9', r: '2' }],
    ['path', { d: 'm21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21' }]
  ],
  // <https://lucide.dev/icons/copy>
  copy: [
    ['rect', { width: '14', height: '14', x: '8', y: '8', rx: '2', ry: '2' }],
    ['path', { d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' }]
  ],
  // <https://lucide.dev/icons/settings>
  settings: [
    [
      'path',
      {
        d: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z'
      }
    ],
    ['circle', { cx: '12', cy: '12', r: '3' }]
  ],
  // <https://lucide.dev/icons/pencil>
  pencil: [
    [
      'path',
      {
        d: 'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z'
      }
    ],
    ['path', { d: 'm15 5 4 4' }]
  ],
  // <https://lucide.dev/icons/plus>
  plus: [
    ['path', { d: 'M5 12h14' }],
    ['path', { d: 'M12 5v14' }]
  ],
  // <https://lucide.dev/icons/save>
  save: [
    ['path', { d: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z' }],
    ['path', { d: 'M17 21v-8H7v8' }],
    ['path', { d: 'M7 3v5h8' }]
  ],
  // <https://lucide.dev/icons/trash-2>
  trash2: [
    ['path', { d: 'M3 6h18' }],
    ['path', { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6' }],
    ['path', { d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }],
    ['line', { x1: '10', x2: '10', y1: '11', y2: '17' }],
    ['line', { x1: '14', x2: '14', y1: '11', y2: '17' }]
  ],
  // <https://lucide.dev/icons/pin>
  pin: [
    ['path', { d: 'M12 17v5' }],
    [
      'path',
      {
        d: 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V5a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z'
      }
    ]
  ],
  // <https://lucide.dev/icons/pin-off>
  pinOff: [
    ['path', { d: 'M12 17v5' }],
    ['path', { d: 'M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89' }],
    ['path', { d: 'm2 2 20 20' }],
    [
      'path',
      {
        d: 'M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11'
      }
    ]
  ]
} satisfies Record<string, readonly ChildSpec[]>;

export type IconName = keyof typeof PATHS;

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgAttrs(size: number): Record<string, string> {
  return {
    viewBox: '0 0 24 24',
    width: String(size),
    height: String(size),
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false'
  };
}

function serializeAttrs(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');
}

/** Render a Lucide icon as an inline SVG string. `size` controls the
 * rendered width/height in pixels; viewBox stays 24×24 so geometry
 * is preserved. The SVG is `aria-hidden`; callers wrap it in an
 * element whose `aria-label` / `title` carries the accessible name. */
export function icon(name: IconName, size = 24): string {
  const root = serializeAttrs(svgAttrs(size));
  const children = PATHS[name].map(([tag, attrs]) => `<${tag} ${serializeAttrs(attrs)}/>`).join('');
  return `<svg ${root}>${children}</svg>`;
}

/** Build a ProseMirror DOMOutputSpec tuple for the same icon — used
 * by TipTap renderHTML callers (figure-node.ts) where the eventual
 * DOM is constructed by prosemirror-model's DOMSerializer. The tag
 * is namespaced so the serializer reaches for createElementNS rather
 * than createElement, which would otherwise drop into the HTML
 * namespace and break SVG rendering. */
export type IconSpec = readonly [string, Record<string, string>, ...ChildSpec[]];

export function iconSpec(name: IconName, size = 24): IconSpec {
  return [`${SVG_NS} svg`, svgAttrs(size), ...PATHS[name]];
}
