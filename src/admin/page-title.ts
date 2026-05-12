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

import { $ } from './dom.ts';

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
