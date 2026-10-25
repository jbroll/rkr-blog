// Macro field dialog for the unified editor: edit an instance's slot
// overrides without touching the macro defaults.
//
// Fields come from the macro's declared defaults; each input starts
// empty with the default as its placeholder, so untouched fields stay
// unset and follow the defaults. Clearing a touched field removes the
// override. Commit merges touched keys over the instance's existing
// slots (never a wholesale replace) and reports exactly the touched
// set, so the shell can save once.
//
// Browser-safe: no node:* imports. The `doc` parameter is the DOM
// `Document` in production; tests pass a structurally compatible fake.

import type { BlockNode, Slots } from '../lib/blocks.ts';

export interface MacroField {
  name: string;
  value: string;
  placeholder: string;
  multiline: boolean;
}

/** One editor per default key, prefilled with the instance override
 * (or empty when the instance follows the default). Multiline for
 * newline-carrying or markdown-shaped values, single-line otherwise. */
export function readMacroFields(node: BlockNode, defaults: Slots): MacroField[] {
  const slots = (node as { slots?: Slots }).slots ?? {};
  return Object.keys(defaults).map((name) => {
    const raw = slots[name];
    const value = typeof raw === 'string' ? raw : '';
    const hint = defaults[name];
    const placeholder = typeof hint === 'string' ? hint : '';
    return {
      name,
      value,
      placeholder,
      multiline: value.includes('\n') || placeholder.includes('\n') || name === 'markdown'
    };
  });
}

export interface MacroDialog {
  /** Programmatic field edit (tests + future rich pickers). */
  setField(name: string, value: string): void;
  /** Commit touched fields; returns false when nothing was touched. */
  commit(): boolean;
  close(): void;
  /** Names touched since open (override set or cleared). */
  touched(): string[];
}

export interface MacroDialogOpts {
  fields: MacroField[];
  onCommit(slots: Slots): void;
  onCancel(): void;
}

export interface MacroDialogRoot {
  ownerDocument: {
    createElement(tag: string): {
      textContent: string | null;
      value?: string;
      className?: string;
      setAttribute?(name: string, value: string): void;
      append?(...nodes: unknown[]): void;
      addEventListener?(type: string, listener: () => void): void;
      querySelectorAll?(selector: string): MacroControl[];
    };
  };
  append(...nodes: unknown[]): void;
  removeChild?(node: unknown): void;
}

interface MacroControl {
  textContent: string | null;
  value?: string;
}

/** Open the macro field dialog. */
export function openMacroDialog(root: MacroDialogRoot, opts: MacroDialogOpts): MacroDialog {
  const doc = root.ownerDocument;
  const values = new Map<string, string>();
  const touched = new Set<string>();
  for (const f of opts.fields) values.set(f.name, f.value);

  const shell = doc.createElement('div');
  shell.className = 'rkr-macro-dialog';
  shell.setAttribute?.('data-rkr-dialog', '');
  shell.setAttribute?.('role', 'dialog');
  shell.setAttribute?.('aria-label', 'Macro settings');

  const inputs = new Map<string, { value?: string } & Record<string, unknown>>();
  for (const f of opts.fields) {
    const label = doc.createElement('label');
    label.textContent = f.name;
    const input = doc.createElement(f.multiline ? 'textarea' : 'input');
    (input as { value?: string }).value = f.value;
    if (f.placeholder) input.setAttribute?.('placeholder', f.placeholder);
    input.setAttribute?.('name', f.name);
    input.addEventListener?.('input', () => {
      const current = inputs.get(f.name);
      const next =
        typeof current?.value === 'string'
          ? current.value
          : (current as { textContent?: string } | undefined)?.textContent;
      if (typeof next === 'string') {
        values.set(f.name, next);
        touched.add(f.name);
      }
    });
    inputs.set(f.name, input as { value?: string } & Record<string, unknown>);
    label.append?.(input);
    shell.append?.(label);
  }
  const footer = doc.createElement('div');
  footer.className = 'rkr-macro-dialog-foot';
  const saveBtn = doc.createElement('button');
  saveBtn.textContent = 'Save macro';
  const cancelBtn = doc.createElement('button');
  cancelBtn.textContent = 'Cancel';
  footer.append?.(saveBtn, cancelBtn);
  shell.append?.(footer);
  root.append(shell);

  const close = (): void => {
    root.removeChild?.(shell);
  };

  const driver: MacroDialog = {
    setField(name, value) {
      if (!values.has(name)) return;
      values.set(name, value);
      touched.add(name);
      const input = inputs.get(name);
      if (input) input.value = value;
    },
    commit(): boolean {
      if (touched.size === 0) return false;
      const slots: Slots = {};
      for (const name of touched) slots[name] = values.get(name) ?? '';
      opts.onCommit(slots);
      close();
      return true;
    },
    close() {
      opts.onCancel();
      close();
    },
    touched() {
      return [...touched];
    }
  };
  saveBtn.addEventListener?.('click', () => {
    driver.commit();
  });
  cancelBtn.addEventListener?.('click', () => {
    driver.close();
  });
  return driver;
}
