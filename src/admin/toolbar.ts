// Toolbar setup for the admin SPA. Builds the bold/italic/heading/link/
// +image/save buttons and exposes the helper that syncs each button's
// active state to the editor's current selection.
//
// Lives in its own module so admin/main.ts can stay focused on figure
// + image-edit panel orchestration; the toolbar is otherwise inert.
// Image insertion is delegated to a single +Image button whose handler
// (main.ts → insertFromAnySource('new')) opens a source picker
// (local file / Google Drive / OneDrive). Pin/unpin moved to the
// per-row controls on /admin/posts.

import type { Editor } from '@tiptap/core';

import { icon } from '../templates/icons.ts';

import { handleSave } from './save';

interface MakeButtonOpts {
  cmd?: string;
  className?: string;
  /** When set, the button renders as an icon with `label` carried as
   * the accessible name (title + aria-label). Static SVG only. */
  iconSvg?: string;
}

function makeButton(
  label: string,
  onClick: () => void,
  opts: MakeButtonOpts = {}
): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  if (opts.iconSvg) {
    b.innerHTML = opts.iconSvg;
    b.title = label;
    b.setAttribute('aria-label', label);
  } else {
    b.textContent = label;
  }
  if (opts.cmd) b.dataset.cmd = opts.cmd;
  if (opts.className) b.className = opts.className;
  b.addEventListener('click', onClick);
  return b;
}

export interface ToolbarDeps {
  editor: Editor;
  toolbar: HTMLElement;
  /** Insert a new figure with images picked from any source. The handler
   * lives in main.ts so the source picker + append-mode plumbing stays
   * in one place; the toolbar only knows the entry point. */
  insertImage: () => Promise<void>;
  /** When true, only the +Image and Save buttons are rendered; text
   * formatting buttons (B/I/H2/H3/Link) are omitted. */
  figureOnly?: boolean;
}

/** Build the toolbar's buttons in place and return a sync callback the
 * caller wires into editor.on('selectionUpdate') so each button's
 * `is-active` class tracks the live selection (bold inside a bold span,
 * heading inside an H2, etc.). */
export function mountToolbar(deps: ToolbarDeps): () => void {
  const { editor, toolbar, insertImage, figureOnly } = deps;
  const buttons: HTMLButtonElement[] = [];
  if (!figureOnly) {
    buttons.push(
      makeButton('B', () => editor.chain().focus().toggleBold().run(), { cmd: 'bold' }),
      makeButton('I', () => editor.chain().focus().toggleItalic().run(), { cmd: 'italic' }),
      makeButton('H2', () => editor.chain().focus().toggleHeading({ level: 2 }).run(), {
        cmd: 'h2'
      }),
      makeButton('H3', () => editor.chain().focus().toggleHeading({ level: 3 }).run(), {
        cmd: 'h3'
      }),
      makeButton(
        'Link',
        () => {
          const url = prompt('URL?');
          if (!url) return;
          editor.chain().focus().setLink({ href: url }).run();
        },
        { cmd: 'link', iconSvg: icon('link', 16) }
      )
    );
  }
  buttons.push(
    makeButton('+Image', () => void insertImage(), {
      cmd: 'image',
      iconSvg: icon('imagePlus', 16)
    }),
    makeButton('Save', () => void handleSave(editor), {
      cmd: 'save',
      className: 'rkr-toolbar-primary',
      iconSvg: icon('save', 16)
    })
  );
  toolbar.replaceChildren(...buttons);

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
