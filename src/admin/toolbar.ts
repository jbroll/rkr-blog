// Toolbar setup for the admin SPA. Builds the bold/italic/heading/link/
// image/gallery/drive/onedrive/save buttons and exposes the helper that
// syncs each button's active state to the editor's current selection.
//
// Lives in its own module so admin/main.ts can stay focused on figure
// + image-edit panel orchestration; the toolbar is otherwise inert.

import type { Editor } from '@tiptap/core';

import { setStatus } from './dom';
import { pickFromDrive } from './integrations/gdrive';
import { pickFromOneDrive } from './integrations/onedrive';
import { pinPost } from './pin';
import { handleSave } from './save';

function makeButton(label: string, onClick: () => void, name?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (name) b.dataset.cmd = name;
  b.addEventListener('click', onClick);
  return b;
}

export interface ToolbarDeps {
  editor: Editor;
  toolbar: HTMLElement;
  /** Hidden file input the Image button clicks. */
  fileInput: HTMLInputElement;
  /** Multi-upload trigger; main.ts owns the picker + uploadMany flow. */
  insertGallery: () => Promise<void>;
}

/** Build the toolbar's buttons in place and return a sync callback the
 * caller wires into editor.on('selectionUpdate') so each button's
 * `is-active` class tracks the live selection (bold inside a bold span,
 * heading inside an H2, etc.). */
export function mountToolbar(deps: ToolbarDeps): () => void {
  const { editor, toolbar, fileInput, insertGallery } = deps;
  toolbar.replaceChildren(
    makeButton('B', () => editor.chain().focus().toggleBold().run(), 'bold'),
    makeButton('I', () => editor.chain().focus().toggleItalic().run(), 'italic'),
    makeButton('H2', () => editor.chain().focus().toggleHeading({ level: 2 }).run(), 'h2'),
    makeButton('H3', () => editor.chain().focus().toggleHeading({ level: 3 }).run(), 'h3'),
    makeButton(
      'Link',
      () => {
        const url = prompt('URL?');
        if (!url) return;
        editor.chain().focus().setLink({ href: url }).run();
      },
      'link'
    ),
    makeButton('Image', () => fileInput.click(), 'image'),
    makeButton('Gallery', () => void insertGallery(), 'gallery'),
    makeButton(
      'Drive',
      () => {
        void pickFromDrive(editor).catch((err: unknown) => {
          setStatus(`Drive: ${(err as Error).message}`);
        });
      },
      'gdrive'
    ),
    makeButton(
      'OneDrive',
      () => {
        void pickFromOneDrive(editor).catch((err: unknown) => {
          setStatus(`OneDrive: ${(err as Error).message}`);
        });
      },
      'onedrive'
    ),
    makeButton('Save', () => void handleSave(editor), 'save'),
    /* v8 ignore next -- prompt-driven UI; e2e drives __rkrPin directly */
    makeButton('Pin', () => void runPin(), 'pin')
  );

  /* v8 ignore start -- prompt-driven UI; e2e drives pinPost via
     window.__rkrPin instead of clicking through prompt() */
  /** Pin flow: prompt for the slug, fetch the bundle, reload so the
   * editor mounts against the freshly-installed draft. Phase 3
   * replaces the prompt with the storage panel's pinned-list. */
  async function runPin(): Promise<void> {
    const slug = prompt('Pin which slug?');
    if (!slug) return;
    setStatus(`pinning /${slug}…`);
    try {
      const result = await pinPost(slug, (p) => {
        setStatus(`pinning /${slug}: ${p.fetched + p.skipped}/${p.total} originals`);
      });
      const note =
        result.progress.failed > 0
          ? `pinned /${slug} (${result.progress.failed} originals failed)`
          : `pinned /${slug}`;
      setStatus(note);
      location.reload();
    } catch (err) {
      setStatus(`pin failed: ${(err as Error).message}`);
    }
  }
  /* v8 ignore stop */

  return function syncActiveStates(): void {
    for (const b of toolbar.querySelectorAll<HTMLButtonElement>('button[data-cmd]')) {
      const cmd = b.dataset.cmd;
      let active = false;
      if (cmd === 'bold') active = editor.isActive('bold');
      else if (cmd === 'italic') active = editor.isActive('italic');
      else if (cmd === 'h2') active = editor.isActive('heading', { level: 2 });
      else if (cmd === 'h3') active = editor.isActive('heading', { level: 3 });
      else if (cmd === 'link') active = editor.isActive('link');
      b.classList.toggle('is-active', active);
    }
  };
}
