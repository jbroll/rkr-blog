// Page settings dialog: title, subtitle, status, publish date, tags and excerpt,
// committed to the tree's `fields` by the unified shell.
//
// Dates are stored as `YYYY-MM-DDT00:00:00Z`, the shape the post index and
// the public templates already read. A stored timestamp is kept as is
// while the author leaves its calendar day alone.
//
// Browser-safe: no node:* imports.

import { openEditorDialog } from './editor-dialog.ts';
import { deduplicateTags, parseTagInput } from './tag-input.ts';

export interface PageFields {
  title: string;
  status: 'draft' | 'published';
  date: string;
  tags: string[];
  excerpt?: string;
  subtitle?: string;
  kind: 'post' | 'page';
}

type FieldName = 'title' | 'subtitle' | 'status' | 'kind' | 'date' | 'tags' | 'excerpt';

const TITLE_REQUIRED = 'Enter a title for the page.';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Stored fields with defaults filled in; unknown keys are ignored. */
export function readPageFields(raw: Record<string, unknown> | undefined, slug: string): PageFields {
  const f = raw ?? {};
  const fields: PageFields = {
    title: typeof f.title === 'string' && f.title !== '' ? f.title : slug,
    status: f.status === 'published' ? 'published' : 'draft',
    date: typeof f.date === 'string' ? f.date : '',
    tags: Array.isArray(f.tags) ? f.tags.filter((t): t is string => typeof t === 'string') : [],
    kind: f.kind === 'page' ? 'page' : 'post'
  };
  if (typeof f.excerpt === 'string' && f.excerpt !== '') fields.excerpt = f.excerpt;
  if (typeof f.subtitle === 'string' && f.subtitle !== '') fields.subtitle = f.subtitle;
  return fields;
}

export type ValidatedPageFields = { ok: true; fields: PageFields } | { ok: false; error: string };

/** `today` is `YYYY-MM-DD`; a published page without a date gets it. */
export function validatePageFields(values: PageFields, today: string): ValidatedPageFields {
  const title = values.title.trim();
  if (title === '') return { ok: false, error: TITLE_REQUIRED };
  let date = values.date.trim();
  if (date === '' && values.status === 'published') date = today;
  if (DAY.test(date)) date = `${date}T00:00:00Z`;
  const fields: PageFields = {
    title,
    status: values.status,
    date,
    tags: deduplicateTags(values.tags.map((t) => t.trim()).filter((t) => t !== '')),
    kind: values.kind
  };
  const excerpt = values.excerpt?.trim();
  if (excerpt) fields.excerpt = excerpt;
  const subtitle = values.subtitle?.trim();
  if (subtitle) fields.subtitle = subtitle;
  return { ok: true, fields };
}

export interface PageSettingsDialog {
  setField(name: FieldName, value: string): void;
}

interface PageSettingsOpts {
  slug: string;
  fields: PageFields;
  onCommit(fields: PageFields): void;
  /** Asked before committing; a message keeps the dialog open with it
   * as the error (e.g. offline), so nothing typed is lost. */
  refuse?(): string | null;
  /** `YYYY-MM-DD`; defaults to the current UTC day. */
  today?: string;
  /** Delete the page; resolves an error message, or null once deleted.
   * Without it there is no Delete page button. */
  onDelete?(): Promise<string | null>;
}

export function openPageSettings(root: Element, opts: PageSettingsOpts): PageSettingsDialog {
  const doc = root.ownerDocument;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const original = opts.fields.date;
  const values: Record<FieldName, string> = {
    title: opts.fields.title,
    subtitle: opts.fields.subtitle ?? '',
    status: opts.fields.status,
    kind: opts.fields.kind,
    date: original.slice(0, 10),
    tags: opts.fields.tags.join(', '),
    excerpt: opts.fields.excerpt ?? ''
  };
  const inputs = new Map<FieldName, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>();

  const form = doc.createElement('div');
  form.className = 'rkr-dialog-fields';

  const addField = (
    name: FieldName,
    labelText: string,
    input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
    hint?: string
  ): void => {
    const row = doc.createElement('div');
    row.className = 'rkr-field';
    const id = `rkr-page-field-${name}`;
    const label = doc.createElement('label');
    label.textContent = labelText;
    label.setAttribute('for', id);
    input.id = id;
    input.setAttribute('name', name);
    input.value = values[name];
    const sync = (): void => {
      values[name] = input.value;
    };
    input.addEventListener('input', sync);
    input.addEventListener('change', sync);
    inputs.set(name, input);
    row.append(label, input);
    if (hint) {
      const note = doc.createElement('p');
      note.className = 'rkr-field-hint';
      note.id = `${id}-hint`;
      note.textContent = hint;
      input.setAttribute('aria-describedby', note.id);
      row.append(note);
    }
    form.append(row);
  };

  const title = doc.createElement('input');
  title.setAttribute('autocomplete', 'off');
  addField('title', 'Title', title);

  const subtitle = doc.createElement('input');
  subtitle.setAttribute('autocomplete', 'off');
  addField('subtitle', 'Subtitle', subtitle, 'Optional. Shown under the title.');

  const status = doc.createElement('select');
  for (const [value, text] of [
    ['draft', 'Draft'],
    ['published', 'Published']
  ] as const) {
    const option = doc.createElement('option');
    option.setAttribute('value', value);
    option.textContent = text;
    status.append(option);
  }
  addField('status', 'Status', status, 'Drafts are visible only when you are signed in.');

  const kind = doc.createElement('select');
  for (const [value, text] of [
    ['post', 'Post'],
    ['page', 'Page']
  ] as const) {
    const option = doc.createElement('option');
    option.setAttribute('value', value);
    option.textContent = text;
    kind.append(option);
  }
  addField(
    'kind',
    'Kind',
    kind,
    'A page has no title header, date or comments, and is not listed on the home page.'
  );

  const date = doc.createElement('input');
  date.setAttribute('type', 'date');
  addField('date', 'Publish date', date);

  const tags = doc.createElement('input');
  tags.setAttribute('autocomplete', 'off');
  tags.setAttribute('placeholder', 'news, recipes');
  addField('tags', 'Tags', tags, 'Separate tags with commas.');

  const excerpt = doc.createElement('textarea');
  excerpt.setAttribute('rows', '3');
  addField('excerpt', 'Excerpt', excerpt, 'Optional. Shown in lists and search results.');

  const url = doc.createElement('p');
  url.className = 'rkr-field-hint';
  const link = doc.createElement('a');
  link.className = 'rkr-page-url';
  link.setAttribute('href', `/${opts.slug}`);
  link.setAttribute('target', '_blank');
  link.setAttribute('rel', 'noopener');
  link.textContent = `/${opts.slug}`;
  url.append(doc.createTextNode('Address: '), link);
  form.append(url);

  const onDelete = opts.onDelete;
  if (onDelete) {
    const remove = doc.createElement('button');
    remove.type = 'button';
    remove.className = 'rkr-edit-btn is-danger rkr-page-delete';
    remove.textContent = 'Delete page';
    remove.addEventListener('click', () => {
      const warning = doc.createElement('p');
      warning.textContent = `Delete “${values.title.trim() || opts.fields.title}”? This can't be undone.`;
      dialog.pushView({
        title: 'Delete page',
        body: warning,
        primaryLabel: 'Delete page',
        cancelLabel: 'Keep page',
        onPrimary: async () => {
          const error = await onDelete();
          if (error) {
            dialog.setError(error);
            return false;
          }
          dialog.close();
          return false;
        }
      });
    });
    form.append(remove);
  }

  const setField = (name: FieldName, value: string): void => {
    values[name] = value;
    const input = inputs.get(name);
    if (input) input.value = value;
  };

  status.addEventListener('change', () => {
    if (values.status === 'published' && values.date === '') setField('date', today);
  });

  const dialog = openEditorDialog({
    root,
    title: 'Page settings',
    body: form,
    primaryLabel: 'Save',
    onPrimary: () => {
      const day = values.date.trim();
      const result = validatePageFields(
        {
          title: values.title,
          status: values.status === 'published' ? 'published' : 'draft',
          kind: values.kind === 'page' ? 'page' : 'post',
          date: day === original.slice(0, 10) ? original : day,
          tags: parseTagInput(values.tags),
          excerpt: values.excerpt,
          subtitle: values.subtitle
        },
        today
      );
      if (!result.ok) {
        title.setAttribute('aria-invalid', 'true');
        dialog.setError(result.error);
        title.focus?.();
        return false;
      }
      const refusal = opts.refuse?.();
      if (refusal) {
        dialog.setError(refusal);
        return false;
      }
      opts.onCommit(result.fields);
      return true;
    }
  });

  return { setField };
}
