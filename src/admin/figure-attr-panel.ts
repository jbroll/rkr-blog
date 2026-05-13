// Figure-attribute panel: commit + debounced-input wiring.
// Extracted from main.ts to keep that file under the 500-line cap
// once per-keystroke blur handlers landed for caption / cell caption /
// cell alt (DEFERRED 9a).

import type { Editor } from '@tiptap/core';
import { cancelPendingAttrCommit, scheduleAttrCommit } from './attr-commit.ts';
import type { FigureAttrs } from './figure-node.ts';

export type CommitFigureAttr = (
  name: keyof FigureAttrs,
  value: string,
  opts?: { addToHistory?: boolean }
) => void;

/** Build a commit function bound to an editor + a populating-state
 * accessor. The populating guard prevents input-readback during
 * panel population from round-tripping through TipTap.
 *
 * `addToHistory: false` emits an intermediate transaction that
 * doesn't enter the undo stack — used for per-keystroke debounced
 * commits so a 50-char caption doesn't become 33 undo entries. Blur
 * handlers re-commit with the default (history-eligible) so there's
 * one undo checkpoint per edit session. */
export function makeCommitFigureAttr(
  editor: Editor,
  isPopulating: () => boolean
): CommitFigureAttr {
  return (name, value, opts) => {
    if (isPopulating() || !editor.isActive('figure')) return;
    const patch: Partial<FigureAttrs> =
      name === 'timer'
        ? { timer: Math.max(0, Math.min(60, Math.floor(Number(value) || 0))) }
        : ({ [name]: value } as Partial<FigureAttrs>);
    const chain = editor.chain().focus();
    if (opts?.addToHistory === false) {
      chain.command(({ tr }) => {
        tr.setMeta('addToHistory', false);
        return true;
      });
    }
    chain.updateAttributes('figure', patch).run();
  };
}

interface DebouncedAttrInput {
  /** Stable key for debounce + cancel. */
  key: string;
  input: HTMLInputElement;
  /** Compute the value to commit. Returns null when the listener
   * should no-op (no active cell, populating, no figure selected). */
  buildValue: () => string | null;
  /** Apply the value. addToHistory: false during typing, true on blur. */
  commit: (value: string, addToHistory: boolean) => void;
  /** Optional side effect after the input event. */
  onInput?: () => void;
}

/** Wire input + blur on a text input that participates in the
 * silent-during-typing, history-checkpoint-on-blur pattern. */
export function wireDebouncedAttrInput(b: DebouncedAttrInput): void {
  b.input.addEventListener('input', () => {
    if (b.buildValue() === null) return;
    scheduleAttrCommit(b.key, () => {
      const latest = b.buildValue();
      if (latest === null) return;
      b.commit(latest, false);
    });
    b.onInput?.();
  });
  b.input.addEventListener('blur', () => {
    cancelPendingAttrCommit(b.key);
    const v = b.buildValue();
    if (v === null) return;
    b.commit(v, true);
  });
}
