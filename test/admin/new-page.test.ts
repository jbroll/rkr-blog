import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { suggestSlug, wireSlugSuggestion } from '../../src/admin/new-page.ts';

type Listener = () => void;
function fakeInput(value = '') {
  const listeners: Listener[] = [];
  return {
    value,
    addEventListener: (_: string, fn: Listener) => listeners.push(fn),
    type(text: string) {
      this.value = text;
      for (const fn of listeners) fn();
    }
  };
}

describe('new page slug suggestion', () => {
  it('turns a title into a slug', () => {
    assert.equal(suggestSlug('Spring Sale!'), 'spring-sale');
    assert.equal(suggestSlug('  Café  au lait '), 'cafe-au-lait');
    assert.equal(suggestSlug('???'), '');
  });

  it('follows the title until the slug is edited', () => {
    const title = fakeInput();
    const slug = fakeInput();
    wireSlugSuggestion(title as unknown as HTMLInputElement, slug as unknown as HTMLInputElement);
    title.type('Spring');
    assert.equal(slug.value, 'spring');
    slug.type('sale');
    title.type('Spring Sale');
    assert.equal(slug.value, 'sale');
  });

  it('leaves a prefilled slug alone', () => {
    const title = fakeInput('Spring');
    const slug = fakeInput('kept');
    wireSlugSuggestion(title as unknown as HTMLInputElement, slug as unknown as HTMLInputElement);
    title.type('Other');
    assert.equal(slug.value, 'kept');
  });
});
