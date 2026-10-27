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
//      blocks.ts) — they must produce HTML strings, not React/Vue
//      components. The npm package's surface is component-shaped.
//   3. Pasting the paths means we never have to think about icon
//      bundling, tree-shaking config, or SSR-only entry points.
//
// All paths are 24x24 viewBox, fill='none', stroke='currentColor',
// stroke-width=2, rounded caps + joins — the Lucide house style.
// Callers pass a size (default 24) that gets stamped onto the
// width / height attributes; viewBox stays fixed so the geometry
// stays proportional.
//
// icon(name, size) returns an HTML string for server-rendered
// templates and the admin bundle.

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
  // <https://lucide.dev/icons/video>
  video: [
    [
      'path',
      {
        d: 'm16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5'
      }
    ],
    ['rect', { x: '2', y: '6', width: '14', height: '12', rx: '2' }]
  ],
  // <https://lucide.dev/icons/message-square>
  comment: [['path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }]],
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
  ],
  // <https://lucide.dev/icons/arrow-up-down> — sort toggle
  arrowUpDown: [
    ['path', { d: 'm21 16-4 4-4-4' }],
    ['path', { d: 'M17 20V4' }],
    ['path', { d: 'm3 8 4-4 4 4' }],
    ['path', { d: 'M7 4v16' }]
  ],
  // <https://lucide.dev/icons/globe> — published (world can see it)
  globe: [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['path', { d: 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20' }],
    ['path', { d: 'M2 12h20' }]
  ],
  // <https://lucide.dev/icons/lock> — draft (private / not yet published)
  lock: [
    ['rect', { width: '18', height: '11', x: '3', y: '11', rx: '2', ry: '2' }],
    ['path', { d: 'M7 11V7a5 5 0 0 1 10 0v4' }]
  ],
  // Header social links. facebook, instagram, youtube and email (mail)
  // are Lucide; Lucide has no Mastodon or Bluesky, so those two are
  // drawn here in the same stroke style.
  facebook: [['path', { d: 'M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z' }]],
  instagram: [
    ['rect', { width: '20', height: '20', x: '2', y: '2', rx: '5', ry: '5' }],
    ['path', { d: 'M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z' }],
    ['line', { x1: '17.5', x2: '17.51', y1: '6.5', y2: '6.5' }]
  ],
  youtube: [
    [
      'path',
      {
        d: 'M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17'
      }
    ],
    ['path', { d: 'm10 15 5-3-5-3z' }]
  ],
  mastodon: [
    [
      'path',
      {
        d: 'M21 13c-.3 1.7-2.7 3.5-5.5 3.8-1.4.2-2.9.3-4.4.2-2.5-.1-4.4-.6-4.4-.6v.7c.3 2.4 2.4 2.6 4.4 2.6 2 .1 3.7-.5 3.7-.5l.1 1.8s-1.4.7-3.8.9c-1.4.1-3.1 0-5.1-.5C3.1 20.4 2.4 16.4 2.2 12.4 2.2 11.2 2.2 10 2.2 9c0-4.4 2.9-5.7 2.9-5.7C6.6 2.6 9.1 2.3 11.7 2.3h.1c2.6 0 5.2.3 6.6 1 0 0 2.9 1.3 2.9 5.7 0 0 0 3.2-.3 4z'
      }
    ],
    ['path', { d: 'M8 13V9a2 2 0 0 1 4 0v3' }],
    ['path', { d: 'M12 12V9a2 2 0 0 1 4 0v4' }]
  ],
  bluesky: [
    [
      'path',
      {
        d: 'M12 11C10.9 8.9 7.9 5 5.2 3.1 2.6 1.3 2 2.6 2 4.2c0 .9.5 4.9.8 5.6.9 2.5 3.5 3.1 5.8 2.7-3.6.6-6.6 2-2.6 6.6 4.5 4.6 6.1-1 6.9-3.9.8 2.9 1.8 8.4 6.9 3.9 3.9-4.6 1-6-2.6-6.6 2.3.4 4.9-.2 5.8-2.7.3-.7.8-4.7.8-5.6 0-1.6-.6-2.9-3.2-1.1C16.1 5 13.1 8.9 12 11z'
      }
    ]
  ],
  // <https://lucide.dev/icons/mail>
  email: [
    ['rect', { width: '20', height: '16', x: '2', y: '4', rx: '2' }],
    ['path', { d: 'm22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7' }]
  ]
} satisfies Record<string, readonly ChildSpec[]>;

export type IconName = keyof typeof PATHS;

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
