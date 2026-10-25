// Tree-backed figure config dialog for the unified editor.
//
// The legacy figure-attr panel is bound to a TipTap `Editor`
// (transactions, undo history, active-cell model) and keeps serving the
// retired editor bundle untouched. This module drives the same dialog
// surface from a block-tree path instead: read the figure's slots,
// validate edits, and commit the merged slots through the shell's
// standard whole-tree save. Unknown slot keys pass through untouched,
// so a commit writes exactly the dialog's fields and nothing else.
//
// The image-edit pipeline (#rkr-image-edit) still lives in the page
// template for the retired editor, but on the blocks page it is stashed
// inside #rkr-image-edit-host. Opening the dialog moves the section
// into the dialog body (preserving element identity for the panel that
// was wired against it); closing moves it back.
//
// Browser-safe: no node:* imports. The `doc` parameter is the DOM
// `Document` in production; tests pass a structurally compatible fake.

import type { BlockNode, Slots } from '../lib/blocks.ts';

const HEX_ID = /^[0-9a-f]{6,64}$/;
const JUSTIFY = new Set(['center', 'full', 'bleed', 'left', 'right', 'inline']);
const JUSTIFY_ORDER = ['center', 'full', 'bleed', 'left', 'right', 'inline'] as const;
const JUSTIFY_LABELS: Record<(typeof JUSTIFY_ORDER)[number], string> = {
  center: 'Center',
  full: 'Full width',
  bleed: 'Full bleed',
  left: 'Float left',
  right: 'Float right',
  inline: 'Inline'
};

export interface FigureFieldValues {
  ids: string;
  alts: string;
  captions: string;
  justify: string;
}

const FIELDS: ReadonlyArray<keyof FigureFieldValues> = ['ids', 'alts', 'captions', 'justify'];

const FIELD_LABELS: Record<keyof FigureFieldValues, string> = {
  ids: 'Image ids (comma-separated)',
  alts: 'Alt text (comma-separated)',
  captions: 'Captions (pipe-separated)',
  justify: 'Position'
};

/** Current slot values as dialog fields. Missing slots read as ''. */
export function readFigureFields(node: BlockNode): FigureFieldValues {
  const slots = (node as { slots?: Slots }).slots ?? {};
  const text = (key: string): string => {
    const v = slots[key];
    return typeof v === 'string' ? v : '';
  };
  return {
    ids: text('ids'),
    alts: text('alts'),
    captions: text('captions'),
    justify: text('justify')
  };
}

export type ValidatedFigureFields = { ok: true; slots: Slots } | { ok: false; errors: string[] };

/** Normalize + validate dialog input. Bad ids reject the whole commit;
 * unknown justify coerces to the renderer default. */
export function validateFigureFields(values: FigureFieldValues): ValidatedFigureFields {
  const errors: string[] = [];
  const ids = values.ids
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  for (const id of ids) {
    if (!HEX_ID.test(id)) errors.push(`id is not a 6-64 char hex sidecar id: ${id}`);
  }
  if (errors.length > 0) return { ok: false, errors };
  const justify = JUSTIFY.has(values.justify) ? values.justify : 'center';
  return {
    ok: true,
    slots: { ids: ids.join(','), alts: values.alts, captions: values.captions, justify }
  };
}

export interface FigureDialog {
  /** Programmatic field edit (tests + future rich pickers). */
  setField(name: keyof FigureFieldValues, value: string): void;
  /** Validate and commit; returns false and surfaces errors on failure. */
  commit(): boolean;
  close(): void;
  errors(): string[];
}

interface FigureDialogOpts {
  initial: FigureFieldValues;
  onCommit(slots: Slots): void;
  /** Called once for every cancelled close (✕, scrim, Escape, Cancel);
   * never for a successful Save-commit. */
  onCancel?(): void;
  /** Resolver for the stashed `#rkr-image-edit` section and its host.
   * Defaults to the guarded global `document.getElementById`; tests
   * inject a map-backed resolver because the fake document has none. */
  getById?(id: string): HTMLElement | null;
}

/** Minimal control surface the dialog needs. Real DOM elements and the
 * test fake both satisfy it; everything beyond is accessed through
 * these members only. */
interface DialogControl {
  textContent: string | null;
  value?: string;
  className?: string;
  id?: string;
  type?: string;
  selected?: boolean;
  setAttribute?(name: string, value: string): void;
  getAttribute?(name: string): string | null;
  append?(...nodes: unknown[]): void;
  addEventListener?(type: string, listener: () => void): void;
  querySelectorAll?(selector: string): DialogControl[];
}

/** Minimal DOM contract the dialog needs (real `Document` satisfies it). */
export interface DialogRoot {
  ownerDocument: {
    createElement(tag: string): DialogControl & {
      append(...nodes: unknown[]): void;
      setAttribute(name: string, value: string): void;
      addEventListener(type: string, listener: () => void): void;
      querySelectorAll(selector: string): DialogControl[];
    };
  };
  append(...nodes: unknown[]): void;
  removeChild?(node: unknown): void;
}

/** Global-document lookup guarded for the fake-DOM unit tests (Node has
 * no `document`). */
function defaultGetById(id: string): HTMLElement | null {
  try {
    return typeof document === 'undefined' ? null : document.getElementById(id);
  } catch {
    return null;
  }
}

/** Open the figure config dialog. Returns a driver the shell (and
 * tests) use instead of touching inputs directly. */
export function openFigureDialog(root: DialogRoot, opts: FigureDialogOpts): FigureDialog {
  const doc = root.ownerDocument;
  const getById = opts.getById ?? defaultGetById;
  const values: FigureFieldValues = { ...opts.initial };
  let errors: string[] = [];
  let closed = false;

  const shell = doc.createElement('div');
  shell.className = 'rkr-cell-dialog rkr-figure-dialog';
  shell.id = 'rkr-figure-config-dialog';
  shell.setAttribute('role', 'dialog');
  shell.setAttribute('aria-modal', 'true');
  shell.setAttribute('aria-labelledby', 'rkr-figure-dialog-title');
  shell.setAttribute('aria-label', 'Figure');

  const head = doc.createElement('div');
  head.className = 'rkr-cell-dialog-head';
  const title = doc.createElement('h2');
  title.id = 'rkr-figure-dialog-title';
  title.textContent = 'Figure';
  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'rkr-cell-dialog-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '\u2715';
  head.append(title, closeBtn);

  const body = doc.createElement('div');
  body.className = 'rkr-cell-dialog-body';
  body.setAttribute('data-scope', 'figure');

  const inputs = new Map<string, DialogControl>();
  for (const name of FIELDS) {
    const field = doc.createElement('div');
    field.className = 'rkr-figure-field';

    const label = doc.createElement('label');
    label.textContent = FIELD_LABELS[name];
    const controlId = `rkr-figure-field-${name}`;
    label.setAttribute('for', controlId);

    const input = doc.createElement(name === 'justify' ? 'select' : 'input');
    input.id = controlId;
    if (name === 'justify') {
      for (const optionValue of JUSTIFY_ORDER) {
        const option = doc.createElement('option');
        option.value = optionValue;
        option.setAttribute('value', optionValue);
        option.textContent = JUSTIFY_LABELS[optionValue];
        if (optionValue === values.justify) {
          option.selected = true;
          option.setAttribute('selected', '');
        }
        input.append?.(option);
      }
      input.value = JUSTIFY.has(values.justify) ? values.justify : 'center';
    } else {
      input.value = values[name];
    }
    input.addEventListener('input', () => {
      const current = inputs.get(name);
      // Test fakes and real inputs both expose .value; unknown elements
      // fall back to textContent so typing is never silently dropped.
      const next = typeof current?.value === 'string' ? current.value : current?.textContent;
      if (typeof next === 'string') values[name] = next;
    });
    inputs.set(name, input);
    field.append(label, input);
    body.append(field);
  }

  // Image selector: thumbnails for each image in the figure. Clicking
  // one makes it the active image for the edit pipeline.
  const ids = values.ids
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const thumbs: DialogControl[] = [];
  const markActive = (active: DialogControl): void => {
    for (const thumb of thumbs) {
      const selected = thumb === active;
      thumb.className = `rkr-figure-image-thumb${selected ? ' is-active' : ''}`;
      thumb.setAttribute?.('aria-pressed', selected ? 'true' : 'false');
    }
  };
  if (ids.length > 0) {
    const selector = doc.createElement('div');
    selector.className = 'rkr-figure-image-selector';
    selector.setAttribute('role', 'group');
    selector.setAttribute('aria-label', 'Images in this figure');
    for (const id of ids) {
      const thumb = doc.createElement('button');
      thumb.type = 'button';
      thumb.className = 'rkr-figure-image-thumb';
      thumb.setAttribute('data-id', id);
      thumb.setAttribute('aria-pressed', 'false');
      thumb.setAttribute('aria-label', `Edit image ${id.slice(0, 8)}\u2026`);
      const img = doc.createElement('img');
      img.setAttribute('src', `/admin/preview/${id}`);
      img.setAttribute('alt', '');
      img.setAttribute('width', '64');
      img.setAttribute('height', '64');
      thumb.append(img);
      thumb.addEventListener('click', () => {
        markActive(thumb);
        const setter = (window as unknown as Record<string, (id: string | null) => void>)
          .__rkrSetActiveImage;
        if (setter) setter(id);
        // The section is now inside the dialog body; unhide it and let
        // the wired panel fetch state + paint the blob preview.
        const section = getById('rkr-image-edit');
        if (section) section.hidden = false;
        const panel = (
          window as unknown as Record<
            string,
            { activateForId: (id: string, fn: () => boolean) => void } | undefined
          >
        ).__rkrImageEditPanel;
        if (panel) panel.activateForId(id, () => true);
      });
      thumbs.push(thumb);
      selector.append(thumb);
    }
    body.append(selector);
  }

  // Move the image-edit pipeline in before the error/footer nodes so
  // #rkr-cell-preview and the op buttons render inside the dialog.
  // Element identity is preserved: wireImageEditPanel holds this node.
  const section = getById('rkr-image-edit');
  if (section) {
    section.hidden = true;
    body.append(section);
  }

  const errorList = doc.createElement('p');
  errorList.className = 'rkr-figure-dialog-errors';
  errorList.setAttribute('role', 'alert');
  body.append(errorList);

  const footer = doc.createElement('div');
  footer.className = 'rkr-figure-dialog-foot';
  const saveBtn = doc.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'rkr-figure-dialog-save';
  saveBtn.textContent = 'Save figure';
  const cancelBtn = doc.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'rkr-figure-dialog-cancel';
  cancelBtn.textContent = 'Cancel';
  footer.append(saveBtn, cancelBtn);
  body.append(footer);

  shell.append(head, body);

  const scrim = doc.createElement('div');
  scrim.className = 'rkr-figure-scrim';
  scrim.setAttribute('aria-hidden', 'true');
  root.append(scrim, shell);

  /** Tear the dialog down: detach the key listener, stash the
   * image-edit section back in its hidden host, then remove the shell
   * and scrim. `cancelled` runs `onCancel` exactly once (✕, Cancel,
   * scrim, Escape) and never for a Save-commit. Idempotent so a second
   * close is a no-op. */
  const close = (cancelled: boolean): void => {
    if (closed) return;
    closed = true;
    detachKey();
    if (section) {
      section.hidden = true;
      const host = getById('rkr-image-edit-host');
      if (host) host.append(section);
    }
    root.removeChild?.(shell);
    root.removeChild?.(scrim);
    if (cancelled) opts.onCancel?.();
  };

  const onKey = (ev: Event): void => {
    if ((ev as KeyboardEvent).key === 'Escape') close(true);
  };
  let keyAttached = false;
  const detachKey = (): void => {
    if (!keyAttached) return;
    keyAttached = false;
    try {
      if (typeof document !== 'undefined') document.removeEventListener('keydown', onKey);
    } catch {
      // document may be unavailable in test environments
    }
  };
  try {
    if (typeof document !== 'undefined') {
      document.addEventListener('keydown', onKey);
      keyAttached = true;
    }
  } catch {
    // ignore
  }

  closeBtn.addEventListener('click', () => close(true));
  scrim.addEventListener('click', () => close(true));
  saveBtn.addEventListener('click', () => {
    driver.commit();
  });
  cancelBtn.addEventListener('click', () => {
    driver.close();
  });

  const driver: FigureDialog = {
    setField(name, value) {
      values[name] = value;
      const input = inputs.get(name);
      if (input) input.value = value;
    },
    commit(): boolean {
      const result = validateFigureFields(values);
      if (!result.ok) {
        errors = result.errors;
        if (errorList) errorList.textContent = result.errors.join(' ');
        return false;
      }
      errors = [];
      opts.onCommit(result.slots);
      close(false);
      return true;
    },
    close() {
      close(true);
    },
    errors() {
      return [...errors];
    }
  };
  return driver;
}
