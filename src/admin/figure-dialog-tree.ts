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
// Browser-safe: no node:* imports. The `doc` parameter is the DOM
// `Document` in production; tests pass a structurally compatible fake.

import type { BlockNode, Slots } from '../lib/blocks.ts';

const HEX_ID = /^[0-9a-f]{6,64}$/;
const JUSTIFY = new Set(['center', 'left', 'right', 'full', 'bleed', 'inline']);

export interface FigureFieldValues {
  ids: string;
  alts: string;
  captions: string;
  justify: string;
}

const FIELDS: ReadonlyArray<keyof FigureFieldValues> = ['ids', 'alts', 'captions', 'justify'];

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
  onCancel(): void;
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
  setAttribute?(name: string, value: string): void;
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

/** Open the figure config dialog. Returns a driver the shell (and
 * tests) use instead of touching inputs directly. */
export function openFigureDialog(root: DialogRoot, opts: FigureDialogOpts): FigureDialog {
  const doc = root.ownerDocument;
  const values: FigureFieldValues = { ...opts.initial };
  let errors: string[] = [];

  const shell = doc.createElement('div');
  shell.className = 'rkr-cell-dialog';
  shell.id = 'rkr-cell-dialog';
  shell.setAttribute('role', 'dialog');
  shell.setAttribute('aria-label', 'Image');
  shell.setAttribute(
    'style',
    'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:1000;'
  );

  const head = doc.createElement('div');
  head.className = 'rkr-cell-dialog-head';
  const title = doc.createElement('h2');
  title.id = 'rkr-figure-dialog-title';
  title.textContent = 'Image';
  const closeBtn = doc.createElement('button');
  closeBtn.className = 'rkr-cell-dialog-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '\u2715';
  head.append(title, closeBtn);
  shell.append(head);

  const body = doc.createElement('div');
  body.className = 'rkr-cell-dialog-body';
  body.setAttribute('data-scope', 'figure');

  const inputs = new Map<string, DialogControl>();
  for (const name of FIELDS) {
    const label = doc.createElement('label');
    label.textContent = name;
    const input = doc.createElement(name === 'justify' ? 'select' : 'input');
    input.value = values[name];
    input.addEventListener('input', () => {
      const current = inputs.get(name);
      // Test fakes and real inputs both expose .value; unknown elements
      // fall back to textContent so typing is never silently dropped.
      const next = typeof current?.value === 'string' ? current.value : current?.textContent;
      if (typeof next === 'string') values[name] = next;
    });
    inputs.set(name, input);
    label.append(input);
    body.append(label);
  }
  // Image selector: thumbnails for each image in the figure.
  // Clicking one sets it as the active image for the edit pipeline.
  const ids = values.ids
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length > 0) {
    const selector = doc.createElement('div');
    selector.className = 'rkr-figure-image-selector';
    for (const id of ids) {
      const thumb = doc.createElement('button');
      thumb.type = 'button';
      thumb.className = 'rkr-figure-image-thumb';
      thumb.setAttribute('data-id', id);
      const img = doc.createElement('img');
      img.setAttribute('src', `/admin/preview/${id}`);
      img.setAttribute('alt', '');
      img.setAttribute('width', '48');
      img.setAttribute('height', '48');
      thumb.append(img);
      thumb.addEventListener('click', () => {
        const setter = (window as unknown as Record<string, (id: string | null) => void>)
          .__rkrSetActiveImage;
        if (setter) setter(id);
        // Show the image-edit section.
        const section = document.getElementById('rkr-image-edit');
        if (section) section.hidden = false;
        const panel = (
          window as unknown as Record<
            string,
            { activateForId: (id: string, fn: () => boolean) => void } | undefined
          >
        ).__rkrImageEditPanel;
        if (panel) panel.activateForId(id, () => true);
      });
      selector.append(thumb);
    }
    body.append(selector);
  }
  // The image-edit elements live in the page template (global). Don't
  // move them into the dialog — the image-edit panel finds them via
  // document.getElementById. The dialog only needs to make them visible
  // when an image is selected (handled by the thumbnail click handler).

  shell.append(body);
  root.append(shell);

  const errorList = doc.createElement('p');
  errorList.className = 'rkr-figure-dialog-errors';
  body.append(errorList);

  const footer = doc.createElement('div');
  footer.className = 'rkr-figure-dialog-foot';
  const saveBtn = doc.createElement('button');
  saveBtn.textContent = 'Save figure';
  const cancelBtn = doc.createElement('button');
  cancelBtn.textContent = 'Cancel';
  footer.append(saveBtn, cancelBtn);
  body.append(footer);

  // Backdrop click + Escape close without committing.
  shell.addEventListener?.('click', ((ev: unknown) => {
    if ((ev as { target?: unknown }).target === shell) close();
  }) as () => void);
  const onKey = (ev: unknown): void => {
    if ((ev as { key?: string }).key === 'Escape') {
      close();
      try {
        document.removeEventListener('keydown', onKey);
      } catch {
        // document may be unavailable in test environments
      }
    }
  };
  try {
    if (typeof document !== 'undefined') document.addEventListener('keydown', onKey);
  } catch {
    // ignore
  }

  closeBtn.addEventListener('click', () => close());
  const close = (): void => {
    root.removeChild?.(shell);
  };

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
      close();
      return true;
    },
    close() {
      opts.onCancel();
      close();
    },
    errors() {
      return [...errors];
    }
  };
  return driver;
}
