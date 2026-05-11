// Editor heading + tab title binding.
//
// Keeps three things in sync:
//   1. The <h1 id="rkr-page-title"> shown above the meta form,
//      reflecting the current post's title (or "New post" when empty).
//   2. document.title — same string, prefixed with a dot when the
//      editor has unsaved changes ("● Editing — <title>").
//   3. A dirty flag bumped by editor updates and meta-input changes,
//      cleared by markClean() after a successful save.

import type { Editor } from '@tiptap/core';

import { $, setStatus } from './dom.ts';

const BASE_TITLE_SUFFIX = ' — rkroll editor';
let dirty = false;

export function initPageTitle(editor: Editor): void {
  const titleInput = $<HTMLInputElement>('rkr-title');
  const subtitleInput = $<HTMLInputElement>('rkr-subtitle');
  const h1 = $('rkr-page-title');

  const render = (): void => {
    const t = titleInput.value.trim() || 'New post';
    h1.textContent = t;
    document.title = `${dirty ? '● ' : ''}${t}${BASE_TITLE_SUFFIX}`;
  };

  // Reflect title-input edits into the h1 + tab title immediately.
  // Subtitle changes mark dirty without re-rendering the h1 (the h1
  // mirrors the title only). Status no longer lives in the editor —
  // it's edited per-row on /admin/posts.
  titleInput.addEventListener('input', () => {
    dirty = true;
    render();
  });
  subtitleInput.addEventListener('input', () => {
    if (dirty) return;
    dirty = true;
    render();
  });
  // Editor content changes mark the doc dirty. `update` fires only
  // on actual doc mutations (not on selection-only transactions), so
  // we don't churn render() during click-to-select interactions in
  // the editable region.
  editor.on('update', () => {
    if (dirty) return;
    dirty = true;
    render();
  });

  render();
}

/** Called by handleSave after a successful publish/save. Clears the
 * dirty dot from the tab title without otherwise touching the h1. */
export function markClean(): void {
  dirty = false;
  const titleInput = $<HTMLInputElement>('rkr-title');
  const t = titleInput.value.trim() || 'New post';
  document.title = `${t}${BASE_TITLE_SUFFIX}`;
}

/** Wire the top-right "Copy link" button. The button is disabled
 * until the hidden slug input is populated (after the first save
 * or a pin-load); save.ts + startup.ts dispatch `rkr-slug-changed`
 * once the slug is known so we can flip the disabled state without
 * polling. */
export function initCopyLink(): void {
  const btn = $<HTMLButtonElement>('rkr-copy-link');
  const slugInput = $<HTMLInputElement>('rkr-slug');
  const refresh = (): void => {
    btn.disabled = !slugInput.value.trim();
  };
  btn.addEventListener('click', () => void copyPostLink());
  window.addEventListener('rkr-slug-changed', refresh);
  refresh();
}

async function copyPostLink(): Promise<void> {
  const slug = $<HTMLInputElement>('rkr-slug').value.trim();
  /* c8 ignore next 4 -- defensive; the button is disabled when there
     is no slug, so this branch is unreachable from the UI but kept
     so a script-driven click still degrades gracefully. */
  if (!slug) {
    setStatus('save the post first — no URL yet');
    return;
  }
  const url = `${location.origin}/${slug}`;
  try {
    await navigator.clipboard.writeText(url);
    setStatus(`copied ${url}`);
  } catch (err) {
    /* c8 ignore next 3 -- production failure path (clipboard
       permission denied in some browsers); show the URL in the
       status line so the author can copy by hand. */
    setStatus(`copy failed: ${(err as Error).message}; URL is ${url}`);
  }
}
