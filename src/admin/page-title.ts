// Editor heading + tab title binding.
//
// Keeps three things in sync:
//   1. The <h1 id="rkr-page-title"> shown above the meta form. It's
//      a mode label — "New post" until the post has a slug,
//      "Edit post" afterwards — NOT the post's title. The post's
//      title goes in the Title input field below. Using the h1 as
//      a mode label rather than a title echo means "the h1 is empty"
//      never happens, and the post being edited is identified by
//      the form fields the author actually sees and changes.
//   2. document.title — uses the post's title for the tab cue
//      (findability) with the same "New post" / "Edit post"
//      fallback, prefixed by ● when the editor has unsaved changes.
//   3. A dirty flag bumped by editor updates and meta-input changes,
//      cleared by markClean() after a successful save.

import type { Editor } from '@tiptap/core';

import { $ } from './dom.ts';

const BASE_TITLE_SUFFIX = ' — rkroll editor';
let dirty = false;

function render(): void {
  const titleInput = $<HTMLInputElement>('rkr-title');
  const slugInput = $<HTMLInputElement>('rkr-slug');
  const h1 = $('rkr-page-title');
  // Slug is the load-state signal: new drafts start blank, the
  // server fills it in on save, pin loads seed it from the bundle.
  const slug = slugInput.value.trim();
  const label = slug ? 'Edit post' : 'New post';
  h1.textContent = label;
  const tabTitle = titleInput.value.trim() || label;
  document.title = `${dirty ? '● ' : ''}${tabTitle}${BASE_TITLE_SUFFIX}`;
  // Mirror the dirty state on the toolbar Save button — CSS in
  // admin-styles.ts uses `.is-dirty` to flip the button from
  // outline-only (calm) to filled (needs action). The tab-title
  // dot was already there for findability, but it's offscreen
  // when the user is focused on the editor.
  const saveBtn = document.querySelector('#rkroll-admin-toolbar button[data-cmd="save"]');
  if (saveBtn) saveBtn.classList.toggle('is-dirty', dirty);
  // View link goes to /<slug>. Hidden until the post is saved so a
  // brand-new draft doesn't show a dead "View" affordance.
  const view = $<HTMLAnchorElement>('rkr-page-view');
  if (slug) {
    // `_about` is a system post served at the clean /about URL
    // (`_`-slugs 404 via /:slug by design); other slugs map 1:1.
    view.href = slug === '_about' ? '/about' : `/${slug}`;
    view.hidden = false;
  } else {
    view.removeAttribute('href');
    view.hidden = true;
  }
}

export function initPageTitle(editor: Editor): void {
  const titleInput = $<HTMLInputElement>('rkr-title');
  const subtitleInput = $<HTMLInputElement>('rkr-subtitle');

  // Title-input edits affect the TAB title (so the browser tab is
  // findable) but the h1 stays a mode label — the author already
  // sees their title in the input. Subtitle changes mark the doc
  // dirty without rerendering the h1 since it's not part of the
  // tab title either.
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

/** Refresh the heading + tab title from current DOM state. Callers
 * use this after programmatic slug / title updates that don't fire
 * 'input' events — seedFormFields (pin load) and the post-save
 * slug echo. Doesn't touch the dirty flag. */
export function refreshPageTitle(): void {
  render();
}

/** Called by handleSave after a successful publish/save. Clears the
 * dirty dot from the tab title without otherwise touching the h1. */
export function markClean(): void {
  dirty = false;
  render();
}
