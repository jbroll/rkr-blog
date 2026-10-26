// Figure and video dialogs for the unified editor, built on the shared
// editor dialog. Authors work with thumbnails: images come from the
// media source picker, each row edits its alt text and caption, and the
// layout is a segmented control. The slots keep their stored encoding
// (figure-image-list.ts), and the commit writes only the dialog's keys;
// the shell merges them over the node's other slots.
//
// "Edit image" pushes the image editor as a sub-view of the same dialog;
// the host (blocks-page-editor-entry.ts) owns the edit pipeline.
//
// Browser-safe: no node:* imports.

import type { Slots } from '../lib/blocks.ts';
import { openEditorDialog } from './editor-dialog.ts';
import {
  type FigureImageRow,
  figureSlotsFromList,
  LAYOUT_LABELS,
  type LayoutChoice,
  layoutFromMatrix,
  listFromFigureSlots,
  matrixFromLayout,
  mountImageList
} from './figure-image-list.ts';
import type { MediaPicker } from './media-source.ts';

const HEX_ID = /^[0-9a-f]{6,64}$/;
const JUSTIFY_ORDER = ['center', 'full', 'bleed', 'left', 'right', 'inline'] as const;
const JUSTIFY = new Set<string>(JUSTIFY_ORDER);
const JUSTIFY_LABELS: Record<(typeof JUSTIFY_ORDER)[number], string> = {
  center: 'Center',
  full: 'Full width',
  bleed: 'Full bleed',
  left: 'Float left',
  right: 'Float right',
  inline: 'Inline'
};
const BAD_ID = "One of these files couldn't be read. Remove it and add it again.";

export interface FigureFieldValues {
  ids: string;
  alts: string;
  captions: string;
  justify: string;
}

export type ValidatedFigureFields = { ok: true; slots: Slots } | { ok: false; errors: string[] };

/** Commit-time check. Bad ids reject the whole commit; unknown justify
 * coerces to the renderer default. */
export function validateFigureFields(values: FigureFieldValues): ValidatedFigureFields {
  const ids = values.ids
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (ids.some((id) => !HEX_ID.test(id))) return { ok: false, errors: [BAD_ID] };
  const justify = JUSTIFY.has(values.justify) ? values.justify : 'center';
  return {
    ok: true,
    slots: { ids: ids.join(','), alts: values.alts, captions: values.captions, justify }
  };
}

/** The image editor the figure dialog swaps in for one image. */
export interface ImageEditorHost {
  /** Mount the editor for `id` inside `into`. */
  open(id: string, into: Element): void;
  /** Commit the edits; resolves false when there was nothing to apply. */
  apply(): Promise<boolean>;
  /** Stash the editor again; `discard` drops unapplied edits. */
  close(discard: boolean): void;
  /** True while the open image has edits that were not applied. */
  dirty(): boolean;
  /** The image's current edit preview, if one was rendered this session.
   * Read live: each repaint revokes the URL before it. */
  previewUrl(id: string): string | null;
}

export interface MediaDialogDeps extends MediaPicker {
  imageEditor?: ImageEditorHost;
  /** Local copy of an image whose upload has not synced yet. */
  localThumbUrl?(id: string): Promise<string | null>;
}

interface MediaDialogOpts {
  kind: 'figure' | 'video';
  slots: Slots;
  /** Just inserted: an empty node opens the picker straight away. */
  fresh?: boolean;
  media: MediaDialogDeps;
  onCommit(slots: Slots): void;
  /** Asked before committing; a message keeps the dialog open with it
   * as the error (e.g. offline), so nothing typed is lost. */
  refuse?(): string | null;
  /** `edited` is true when image edits were applied before cancelling,
   * so the page needs a fresh render. */
  onCancel?(edited: boolean): void;
}

const text = (slots: Slots, key: string): string => {
  const v = slots[key];
  return typeof v === 'string' ? v : '';
};

function section(doc: Document, heading: string): HTMLElement {
  const el = doc.createElement('section');
  el.className = 'rkr-media-section';
  const h = doc.createElement('h3');
  h.className = 'rkr-media-heading';
  h.textContent = heading;
  el.append(h);
  return el;
}

/** "Discard unapplied edits?" in the editor dialog style; true discards. */
function confirmDiscard(root: Element): Promise<boolean> {
  const doc = root.ownerDocument;
  return new Promise((resolve) => {
    const body = doc.createElement('p');
    body.className = 'rkr-confirm-text';
    body.textContent = 'The changes you made to this image have not been applied.';
    openEditorDialog({
      root,
      title: 'Discard unapplied edits?',
      body,
      primaryLabel: 'Discard',
      cancelLabel: 'Keep editing',
      onPrimary: () => {
        resolve(true);
        return true;
      },
      onCancel: () => resolve(false)
    });
  });
}

function positionField(
  doc: Document,
  initial: string,
  positions: readonly (typeof JUSTIFY_ORDER)[number][],
  onChange: (v: string) => void
) {
  const wrap = doc.createElement('div');
  wrap.className = 'rkr-field';
  const label = doc.createElement('label');
  label.textContent = 'Position';
  label.setAttribute('for', 'rkr-media-justify');
  const select = doc.createElement('select');
  select.id = 'rkr-media-justify';
  for (const value of positions) {
    const option = doc.createElement('option');
    option.value = value;
    option.setAttribute('value', value);
    option.textContent = JUSTIFY_LABELS[value];
    select.append(option);
  }
  select.value = (positions as readonly string[]).includes(initial) ? initial : 'center';
  select.addEventListener('change', () => onChange(select.value));
  wrap.append(label, select);
  return wrap;
}

function numberField(doc: Document, label: string, value: number, onInput: (n: number) => void) {
  const wrap = doc.createElement('div');
  wrap.className = 'rkr-field';
  const id = `rkr-media-${label.toLowerCase()}`;
  const lab = doc.createElement('label');
  lab.textContent = label;
  lab.setAttribute('for', id);
  const input = doc.createElement('input');
  input.id = id;
  input.type = 'number';
  input.setAttribute('min', '1');
  input.setAttribute('max', '12');
  input.value = String(value);
  input.addEventListener('input', () => onInput(Number(input.value)));
  wrap.append(lab, input);
  return wrap;
}

/** Segmented Single / Grid / Carousel / Justified / Masonry control,
 * with rows and columns shown for Grid. */
function layoutControl(doc: Document, layout: LayoutChoice) {
  const wrap = doc.createElement('div');
  wrap.className = 'rkr-layout-control';
  const group = doc.createElement('div');
  group.className = 'rkr-segmented';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', 'Layout');
  const grid = doc.createElement('div');
  grid.className = 'rkr-layout-grid';
  grid.append(
    numberField(doc, 'Rows', layout.rows, (n) => {
      layout.rows = n;
    }),
    numberField(doc, 'Columns', layout.cols, (n) => {
      layout.cols = n;
    })
  );
  const radios: HTMLButtonElement[] = [];
  const sync = (): void => {
    for (const r of radios) {
      r.setAttribute('aria-checked', r.dataset.mode === layout.mode ? 'true' : 'false');
    }
    grid.hidden = layout.mode !== 'grid';
  };
  for (const [mode, label] of LAYOUT_LABELS) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'rkr-segment';
    btn.setAttribute('role', 'radio');
    btn.dataset.mode = mode;
    btn.textContent = label;
    btn.addEventListener('click', () => {
      layout.mode = mode;
      sync();
    });
    radios.push(btn);
    group.append(btn);
  }
  sync();
  wrap.append(group, grid);
  return { element: wrap, sync };
}

/** Open the figure or video dialog. */
export function openMediaDialog(root: Element, opts: MediaDialogOpts): void {
  const doc = root.ownerDocument;
  const video = opts.kind === 'video';
  const kind = video ? 'video' : 'image';
  let rows: FigureImageRow[] = video
    ? text(opts.slots, 'ids')
      ? [{ id: text(opts.slots, 'ids'), alt: '', caption: text(opts.slots, 'caption') }]
      : []
    : listFromFigureSlots(opts.slots);
  const layout = layoutFromMatrix(text(opts.slots, 'matrix'));
  let justify = text(opts.slots, 'justify') || 'center';
  let edited = false;

  const body = doc.createElement('div');
  body.className = 'rkr-dialog-fields rkr-media-dialog';

  const media = section(doc, video ? 'Video' : 'Images');
  const empty = doc.createElement('p');
  empty.className = 'rkr-media-empty';
  empty.textContent = video ? 'No video yet.' : 'No images yet.';
  const add = doc.createElement('button');
  add.type = 'button';
  add.className = 'rkr-edit-btn rkr-media-add';

  const editor = video ? undefined : opts.media.imageEditor;
  const list = mountImageList(doc, {
    rows,
    kind,
    thumbUrl: (id) => editor?.previewUrl(id) ?? opts.media.thumbUrl(kind, id),
    localThumbUrl: video ? undefined : opts.media.localThumbUrl,
    onChange: (next) => {
      rows = next;
      refresh();
    },
    onEdit: editor ? (i) => editImage(editor, i) : undefined
  });

  const refresh = (): void => {
    empty.hidden = rows.length > 0;
    add.textContent = video ? (rows.length ? 'Replace video' : 'Add video') : 'Add images';
  };
  media.append(list.element, empty, add);
  body.append(media);

  let control: ReturnType<typeof layoutControl> | null = null;
  if (!video) {
    const layoutSection = section(doc, 'Layout');
    control = layoutControl(doc, layout);
    layoutSection.append(control.element);
    body.append(layoutSection);
  }
  body.append(
    // The video renderer has no inline layout; it maps inline to center.
    positionField(
      doc,
      justify,
      video ? JUSTIFY_ORDER.filter((j) => j !== 'inline') : JUSTIFY_ORDER,
      (v) => {
        justify = v;
      }
    )
  );
  refresh();

  const pickInto = async (): Promise<void> => {
    add.setAttribute('disabled', '');
    try {
      const ids = await opts.media.pick(kind, !video);
      if (ids.length === 0) return;
      const picked = ids.map((id) => ({ id, alt: '', caption: '' }));
      if (video) {
        rows = [{ ...(picked[0] as FigureImageRow), caption: rows[0]?.caption ?? '' }];
      } else {
        if (rows.length === 0 && picked.length > 1 && layout.mode === 'single') {
          layout.mode = 'justified';
          control?.sync();
        }
        rows = [...rows, ...picked];
      }
      list.setRows(rows);
      refresh();
    } catch (err) {
      console.error('media pick:', err);
      dialog.setError("Couldn't add that file. Try again.");
    } finally {
      add.removeAttribute('disabled');
    }
  };
  add.addEventListener('click', () => {
    void pickInto();
  });

  const editImage = (host: ImageEditorHost, index: number): void => {
    const row = rows[index];
    if (!row) return;
    const into = doc.createElement('div');
    into.className = 'rkr-image-editor';
    dialog.pushView({
      title: 'Edit image',
      body: into,
      primaryLabel: 'Apply edits',
      cancelLabel: 'Back to figure',
      onPrimary: async () => {
        if (await host.apply()) edited = true;
        return true;
      },
      onLeave: (cancelled) => {
        host.close(cancelled);
        list.refresh();
      },
      confirmLeave: () => !host.dirty() || confirmDiscard(root)
    });
    host.open(row.id, into);
  };

  const commit = (): boolean => {
    if (!opts.fresh && rows.length === 0) {
      dialog.setError(
        video ? 'Pick a video, or delete the block.' : 'Pick an image, or delete the block.'
      );
      return false;
    }
    let slots: Slots;
    if (video) {
      slots = { ids: rows[0]?.id ?? '', caption: rows[0]?.caption.trim() ?? '', justify };
    } else {
      slots = figureSlotsFromList(rows, { matrix: matrixFromLayout(layout), justify });
    }
    const checked = validateFigureFields({
      ids: text(slots, 'ids'),
      alts: text(slots, 'alts'),
      captions: text(slots, 'captions'),
      justify
    });
    if (!checked.ok) {
      dialog.setError(checked.errors.join(' '));
      return false;
    }
    const refusal = opts.refuse?.();
    if (refusal) {
      dialog.setError(refusal);
      return false;
    }
    opts.onCommit({ ...slots, justify: text(checked.slots, 'justify') });
    return true;
  };

  const dialog = openEditorDialog({
    root,
    title: video ? 'Video' : 'Figure',
    body,
    primaryLabel: video ? 'Save video' : 'Save figure',
    wide: true,
    onPrimary: commit,
    onCancel: () => opts.onCancel?.(edited)
  });

  if (opts.fresh && rows.length === 0) void pickInto();
}
