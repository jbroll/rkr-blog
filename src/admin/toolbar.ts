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

import { handleSave } from './save';

// SVG glyphs for the icon-style toolbar buttons. Static strings, so
// the innerHTML assignment in makeButton is safe (no user input).
// Link: two interlocking link rings; +Image: framed picture with a
// plus badge in the bottom-right. Both currentColor + 16x16 so they
// inherit the toolbar's text colour and align with the B / I / H2
// glyphs that stayed as text.
const LINK_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
  <path d="M7 9.5l2-3M6 10.5l-1 1a2.5 2.5 0 0 1-3.5-3.5l2-2a2.5 2.5 0 0 1 3.5 0M10 5.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-2 2a2.5 2.5 0 0 1-3.5 0"
        fill="none" stroke="currentColor" stroke-width="1.5"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
const ADD_IMAGE_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
  <rect x="1.5" y="2.5" width="10" height="8" rx="1.5"
        fill="none" stroke="currentColor" stroke-width="1.5"/>
  <circle cx="4.5" cy="5.25" r="1" fill="currentColor"/>
  <path d="M2.5 9.5l2-2 2 2 1.5-1.5 3 3" fill="none"
        stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
  <path d="M12.5 11.5v4M10.5 13.5h4" fill="none"
        stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
</svg>`;

interface MakeButtonOpts {
  cmd?: string;
  className?: string;
  /** When set, the button renders as an icon with `label` carried as
   * the accessible name (title + aria-label). Static SVG only. */
  icon?: string;
}

function makeButton(
  label: string,
  onClick: () => void,
  opts: MakeButtonOpts = {}
): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  if (opts.icon) {
    b.innerHTML = opts.icon;
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
}

/** Build the toolbar's buttons in place and return a sync callback the
 * caller wires into editor.on('selectionUpdate') so each button's
 * `is-active` class tracks the live selection (bold inside a bold span,
 * heading inside an H2, etc.). */
export function mountToolbar(deps: ToolbarDeps): () => void {
  const { editor, toolbar, insertImage } = deps;
  toolbar.replaceChildren(
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
      { cmd: 'link', icon: LINK_ICON }
    ),
    makeButton('+Image', () => void insertImage(), { cmd: 'image', icon: ADD_IMAGE_ICON }),
    makeButton('Save', () => void handleSave(editor), {
      cmd: 'save',
      className: 'rkr-toolbar-primary'
    })
  );

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
