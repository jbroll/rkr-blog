// Blocks editor entry: hydrates the server-rendered page in place.
// The edit route embeds the canonical tree (#rkr-tree) and renders the
// public body with `rkr:path` markers, so this module only mounts the
// unified shell: no page fetch, no client-side renderer, no iframe
// preview. Structural edits re-render through POST /admin/blocks/_render.
// Same-origin fetch carries the admin session cookie, so no token
// handling is needed here; scripted clients use /admin/blocks/:slug.

import type { BlockTree } from '../lib/blocks.ts';
import type { PaletteMacro } from './blocks-editor.ts';
import { wireImageEditPanel } from './image-edit-panel.ts';
import { initOpfsForUnifiedEditor } from './opfs-init-unified.ts';
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

  const render = async (next: BlockTree): Promise<string> => {
    const res = await fetch('/admin/blocks/_render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tree: next })
    });
    if (!res.ok) throw new Error(`render page ${res.status}`);
    return ((await res.json()) as { html: string }).html;
  };

  void (async () => {
    try {
      const res = await fetch('/admin/blocks/macros');
      if (!res.ok) throw new Error(`load macros ${res.status}`);
      const macros = (await res.json()) as PaletteMacro[];
      mountUnifiedShell(root, { tree, macros, onSave: save, render });

      // Initialize OPFS for image editing.
      const opfsReady = await initOpfsForUnifiedEditor();

      // Wire the image-edit panel with a mock editor whose view.dom
      // contains an img.rkr-image[data-id] for the active image.
      // The panel uses editor only for refreshImagePreview, which
      // updates img.rkr-image[data-id] src. We provide a container.
      const imageEditContainer = document.createElement('div');
      imageEditContainer.id = 'rkr-image-edit-container';
      root.append(imageEditContainer);

      let activeImageIdValue: string | null = null;
      const mockEditor = {
        view: { dom: imageEditContainer },
        isActive: () => true,
        getAttributes: () => ({}),
        chain: () => ({
          focus: () => ({
            command: () => ({ run: () => true }),
            updateAttributes: () => ({ run: () => true })
          })
        })
      } as unknown as import('@tiptap/core').Editor;

      if (opfsReady) {
        const panel = wireImageEditPanel({
          editor: mockEditor,
          section: document.getElementById('rkr-image-edit') as HTMLDivElement,
          buttons: {
            crop: document.getElementById('rkr-image-crop-btn') as HTMLButtonElement,
            rotateL: document.getElementById('rkr-image-rotate-l-btn') as HTMLButtonElement,
            rotateR: document.getElementById('rkr-image-rotate-r-btn') as HTMLButtonElement,
            flipH: document.getElementById('rkr-image-flip-h-btn') as HTMLButtonElement,
            flipV: document.getElementById('rkr-image-flip-v-btn') as HTMLButtonElement,
            perspective: document.getElementById('rkr-image-perspective-btn') as HTMLButtonElement,
            undo: document.getElementById('rkr-image-undo-btn') as HTMLButtonElement,
            redo: document.getElementById('rkr-image-redo-btn') as HTMLButtonElement,
            reset: document.getElementById('rkr-image-reset-btn') as HTMLButtonElement,
            save: document.getElementById('rkr-image-save-btn') as HTMLButtonElement,
            resample: document.getElementById('rkr-image-resample-btn') as HTMLButtonElement,
            tilt: document.getElementById('rkr-image-tilt-btn') as HTMLButtonElement
          },
          resampleInput: document.getElementById('rkr-image-resample') as HTMLInputElement,
          tiltSlider: document.getElementById('rkr-image-tilt-slider') as HTMLInputElement,
          tiltInput: document.getElementById('rkr-image-tilt-input') as HTMLInputElement,
          editsList: document.getElementById('rkr-image-edits') as HTMLOListElement,
          activeImageId: () => activeImageIdValue
        });
        (window as unknown as Record<string, unknown>).__rkrImageEditPanel = panel;
      }

      // Expose for the figure dialog to set the active image.
      (window as unknown as Record<string, unknown>).__rkrSetActiveImage = (id: string | null) => {
        activeImageIdValue = id;
        // Update the mock editor's view.dom with an img for this id.
        imageEditContainer.innerHTML = '';
        if (id) {
          const img = document.createElement('img');
          img.className = 'rkr-image';
          img.setAttribute('data-id', id);
          img.src = `/admin/preview/${id}`;
          imageEditContainer.append(img);
          const preview = document.getElementById('rkr-cell-preview') as HTMLImageElement | null;
          if (preview) {
            preview.src = `/admin/preview/${id}`;
            preview.hidden = false;
          }
        }
      };
    } catch (err: unknown) {
      root.innerHTML = `<p role="alert">Editor failed to load: ${err instanceof Error ? err.message : String(err)}</p>`;
    }
  })();
}
