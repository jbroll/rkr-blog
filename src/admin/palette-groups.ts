// Palette grouping and icons for the editor dock.
// Browser-safe: no node:* imports.

const GROUP_ORDER = ['Basics', 'Media', 'Layout', 'Sections'] as const;

export interface PaletteGroup<T> {
  group: string;
  items: T[];
}

/** Group entries in the fixed dock order. An entry without a group is a
 * site macro, so it lands under Sections; empty groups are dropped. */
export function groupPalette<T extends { group?: string }>(entries: T[]): PaletteGroup<T>[] {
  const byGroup = new Map<string, T[]>();
  for (const entry of entries) {
    const group = entry.group ?? 'Sections';
    const list = byGroup.get(group) ?? [];
    list.push(entry);
    byGroup.set(group, list);
  }
  const known = GROUP_ORDER.filter((g) => byGroup.has(g));
  const extra = [...byGroup.keys()].filter((g) => !(GROUP_ORDER as readonly string[]).includes(g));
  return [...known, ...extra].map((group) => ({ group, items: byGroup.get(group) ?? [] }));
}

const svg = (body: string): string =>
  `<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const ICONS: Record<string, string> = {
  'primitive:text': svg('<path d="M4 5h12M4 9h12M4 13h8"/>'),
  'primitive:button': svg('<rect x="2.5" y="6" width="15" height="8" rx="4"/><path d="M7 10h6"/>'),
  'primitive:figure': svg(
    '<rect x="2.5" y="4" width="15" height="12" rx="1.5"/><circle cx="7" cy="8.5" r="1.2"/><path d="M3 14.5l4.5-4 3 2.5 3-3 3.5 3.5"/>'
  ),
  'primitive:video': svg(
    '<rect x="2.5" y="4.5" width="15" height="11" rx="1.5"/><path d="M8.5 7.5v5l4-2.5z"/>'
  ),
  'primitive:section': svg(
    '<rect x="2.5" y="3.5" width="15" height="13" rx="1.5"/><path d="M2.5 7.5h15"/>'
  ),
  'primitive:row': svg(
    '<rect x="2.5" y="5" width="6" height="10" rx="1"/><rect x="11.5" y="5" width="6" height="10" rx="1"/>'
  ),
  'primitive:col': svg(
    '<rect x="5" y="2.5" width="10" height="6" rx="1"/><rect x="5" y="11.5" width="10" height="6" rx="1"/>'
  )
};

const MACRO_ICON = svg(
  '<rect x="2.5" y="3.5" width="15" height="13" rx="1.5"/><path d="M6 8h8M6 12h5"/>'
);

/** Static icon markup per palette name; safe to assign to innerHTML. */
export function paletteIcon(name: string): string {
  return ICONS[name] ?? MACRO_ICON;
}
