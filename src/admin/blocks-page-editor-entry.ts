// Blocks editor entry: hydrates the server-rendered page in place.
// The edit route embeds the canonical tree (#rkr-tree) and renders the
// public body with `rkr:path` markers, so this module only mounts the
// unified shell: no page fetch, no client re-render, no iframe preview.
// Same-origin fetch carries the admin session cookie, so no token
// handling is needed here; scripted clients use /admin/blocks/:slug.

import type { BlockTree } from '../lib/blocks.ts';
import type { PaletteMacro } from './blocks-editor.ts';
import { mountUnifiedShell } from './unified-shell.ts';

const root = document.getElementById('rkr-blocks-edit-root');
const slug = root?.dataset.slug ?? '';

/** The canonical tree the server embedded for this page. */
function embeddedTree(): BlockTree | null {
  const script = document.getElementById('rkr-tree');
  if (!script?.textContent) return null;
  try {
    return JSON.parse(script.textContent) as BlockTree;
  } catch {
    return null;
  }
}

const tree = embeddedTree();

if (root && slug && tree) {
  const save = async (next: BlockTree): Promise<void> => {
    const res = await fetch(`/admin/blocks/${encodeURIComponent(slug)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tree: next })
    });
    if (!res.ok) throw new Error(`save page ${res.status}`);
  };

  void (async () => {
    try {
      const res = await fetch('/admin/blocks/macros');
      if (!res.ok) throw new Error(`load macros ${res.status}`);
      const macros = (await res.json()) as PaletteMacro[];
      mountUnifiedShell(root, { tree, macros, onSave: save });
    } catch (err: unknown) {
      root.innerHTML = `<p role="alert">Editor failed to load: ${err instanceof Error ? err.message : String(err)}</p>`;
    }
  })();
}
