// Embed config dialog for the unified editor: a URL and a height. Share
// links are rewritten to embed URLs on save.
//
// Browser-safe: no node:* imports.

import type { BlockNode, Slots } from '../lib/blocks.ts';
import { toEmbedUrl } from '../lib/embed-allow.ts';
import { type FieldsDialog, openFieldsDialog, type Validated } from './fields-dialog.ts';

export interface EmbedFields extends Record<string, string> {
  url: string;
  height: string;
}

const UNSUPPORTED =
  "This service can't be embedded. Supported: Google Docs, Forms and Maps, YouTube, Vimeo.";

export function readEmbedFields(node: BlockNode): EmbedFields {
  const slots = (node as { slots?: Slots }).slots ?? {};
  const { url, height } = slots;
  return {
    url: typeof url === 'string' ? url : '',
    height: typeof height === 'number' || typeof height === 'string' ? String(height) : ''
  };
}

export function validateEmbedFields(values: EmbedFields): Validated {
  if (values.url.trim() === '') {
    return { ok: false, error: 'Enter a link to embed.', field: 'url' };
  }
  const url = toEmbedUrl(values.url);
  if (!url) return { ok: false, error: UNSUPPORTED, field: 'url' };
  const raw = values.height.trim();
  if (raw === '') return { ok: true, slots: { url } };
  const height = Number(raw);
  if (!Number.isFinite(height) || height <= 0) {
    return { ok: false, error: 'Height must be a number of pixels.', field: 'height' };
  }
  return { ok: true, slots: { url, height } };
}

interface EmbedDialogOpts {
  initial: EmbedFields;
  onCommit(slots: Slots): void;
  refuse?(): string | null;
  onCancel?(): void;
}

export function openEmbedDialog(root: Element, opts: EmbedDialogOpts): FieldsDialog<EmbedFields> {
  return openFieldsDialog<EmbedFields>(root, {
    ...opts,
    title: 'Edit embed',
    idPrefix: 'rkr-embed-field',
    fields: [
      { name: 'url', label: 'URL', kind: 'text', placeholder: 'https://docs.google.com/forms/…' },
      { name: 'height', label: 'Height', kind: 'number', placeholder: '600' }
    ],
    validate: validateEmbedFields
  });
}
