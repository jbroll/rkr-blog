// Tag-input widget: wraps a container div and manages a list of tag
// pills the user can add (type + Enter/comma) or remove (× button).
// Pure logic is exported separately so unit tests don't need a DOM.

/** Parse a raw input string into candidate tag names: split on commas,
 * trim whitespace, drop blanks and entries over MAX_TAG_LEN chars. */
export const MAX_TAG_LEN = 32;

export function parseTagInput(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= MAX_TAG_LEN);
}

/** Deduplicate tags case-insensitively, keeping first occurrence. */
export function deduplicateTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const key = t.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

export interface TagInputWidget {
  getTags: () => string[];
  setTags: (tags: string[]) => void;
}

/** Mount the tag-input widget on the given container element.
 * Returns { getTags, setTags } for integration with save.ts and
 * startup.ts. The widget manages its own DOM; callers should not
 * reach into the container directly. */
/* c8 ignore start -- DOM-coupled; tested via e2e */
export function createTagInput(container: HTMLElement): TagInputWidget {
  let tags: string[] = [];

  function render(): void {
    container.innerHTML = '';
    for (const tag of tags) {
      const pill = document.createElement('span');
      pill.className = 'rkr-tag-pill-editor';
      pill.textContent = tag;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rkr-tag-remove';
      btn.setAttribute('aria-label', `Remove tag ${tag}`);
      btn.textContent = '×';
      btn.addEventListener('click', () => {
        tags = tags.filter((t) => t !== tag);
        render();
      });

      pill.appendChild(btn);
      container.appendChild(pill);
    }

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'rkr-tag-input-field';
    input.placeholder = tags.length === 0 ? 'add tags…' : '';
    input.setAttribute('aria-label', 'Add tag');

    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const candidates = parseTagInput(input.value);
        if (candidates.length > 0) {
          tags = deduplicateTags([...tags, ...candidates]);
          render();
        }
      } else if (e.key === 'Backspace' && input.value === '' && tags.length > 0) {
        tags = tags.slice(0, -1);
        render();
      }
    });

    input.addEventListener('blur', () => {
      if (input.value.trim()) {
        const candidates = parseTagInput(input.value);
        if (candidates.length > 0) {
          tags = deduplicateTags([...tags, ...candidates]);
          render();
        }
      }
    });

    container.appendChild(input);
  }

  render();

  return {
    getTags: () => [...tags],
    setTags: (next: string[]) => {
      tags = deduplicateTags(next.filter((t) => typeof t === 'string' && t.trim().length > 0));
      render();
    }
  };
}
/* c8 ignore stop */
