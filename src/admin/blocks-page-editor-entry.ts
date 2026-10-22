// Blocks editor shell: mounts the JSON tree-view editor for one page.
// Same-origin fetch carries the admin session cookie, so no token
// handling is needed here; scripted clients use /admin/blocks/:slug.

import type { BlockTree } from '../lib/blocks.ts';
import { mountBlocksPageEditor } from './blocks-page-editor.ts';

const root = document.getElementById('rkr-blocks-edit-root');
const slug = root?.dataset.slug ?? '';

if (root && slug) {
  mountBlocksPageEditor(root, {
    loadPage: async () => {
      const res = await fetch(`/admin/blocks/${encodeURIComponent(slug)}`);
      if (!res.ok) throw new Error(`load page ${res.status}`);
      return (await res.json()) as { title: string; tree: BlockTree };
    },
    loadMacros: async () => {
      const res = await fetch('/admin/blocks/macros');
      if (!res.ok) throw new Error(`load macros ${res.status}`);
      return (await res.json()) as { name: string; label: string }[];
    },
    savePage: async (tree) => {
      const res = await fetch(`/admin/blocks/${encodeURIComponent(slug)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tree })
      });
      if (!res.ok) throw new Error(`save page ${res.status}`);
    },
    renderPreview: async (_tree, width) =>
      `<iframe src="/pages/${encodeURIComponent(slug)}" title="Saved preview" style="max-width:${width}px;width:100%;height:600px;border:1px dashed var(--rkr-rule)"></iframe>`
  }).catch((err: unknown) => {
    root.innerHTML = `<p role="alert">Editor failed to load: ${err instanceof Error ? err.message : String(err)}</p>`;
  });
}
