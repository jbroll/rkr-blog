// New-page form: suggests the slug from the title until the author edits the slug.

const MAX_SLUG = 100;

export function suggestSlug(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '');
}

export function wireSlugSuggestion(title: HTMLInputElement, slug: HTMLInputElement): void {
  let edited = slug.value !== '';
  slug.addEventListener('input', () => {
    edited = slug.value !== '';
  });
  title.addEventListener('input', () => {
    if (!edited) slug.value = suggestSlug(title.value);
  });
}

// Tests import this module under node, where there is no document.
if (typeof document !== 'undefined') {
  const title = document.getElementById('rkr-new-title');
  const slug = document.getElementById('rkr-new-slug');
  if (title instanceof HTMLInputElement && slug instanceof HTMLInputElement) {
    wireSlugSuggestion(title, slug);
  }
}
