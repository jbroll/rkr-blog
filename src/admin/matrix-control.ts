// DOM wiring for the visual matrix control. The pure parse + serialize
// + types live in matrix-spec.ts so they can be unit-tested under the
// server tsconfig; this file is the browser side (radios + spinboxes
// → wire-format string + back).

import {
  clampDim,
  FLOW_DEFAULTS,
  type MatrixSpec,
  parseMatrix,
  serializeMatrix
} from '../lib/matrix.ts';

export interface MatrixControl {
  /** Re-populate every input from a wire-format string (called when
   * the editor selects a different figure). Does not fire onChange —
   * the populate path must not commit a no-op edit. */
  setFromRaw(raw: string): void;
}

interface ControlElements {
  modeGrid: HTMLInputElement;
  modeJustified: HTMLInputElement;
  modeMasonry: HTMLInputElement;
  rows: HTMLInputElement;
  cols: HTMLInputElement;
  height: HTMLInputElement;
  mcols: HTMLInputElement;
  groupGrid: HTMLElement;
  groupJustified: HTMLElement;
  groupMasonry: HTMLElement;
}

function findElements(root: HTMLElement): ControlElements {
  const must = <T extends HTMLElement>(sel: string): T => {
    const el = root.querySelector<T>(sel);
    if (!el) throw new Error(`matrix-control: missing ${sel}`);
    return el;
  };
  return {
    modeGrid: must<HTMLInputElement>('input[name="rkr-matrix-mode"][value="grid"]'),
    modeJustified: must<HTMLInputElement>('input[name="rkr-matrix-mode"][value="justified"]'),
    modeMasonry: must<HTMLInputElement>('input[name="rkr-matrix-mode"][value="masonry"]'),
    rows: must<HTMLInputElement>('#rkr-matrix-rows'),
    cols: must<HTMLInputElement>('#rkr-matrix-cols'),
    height: must<HTMLInputElement>('#rkr-matrix-height'),
    mcols: must<HTMLInputElement>('#rkr-matrix-mcols'),
    groupGrid: must<HTMLElement>('[data-matrix-group="grid"]'),
    groupJustified: must<HTMLElement>('[data-matrix-group="justified"]'),
    groupMasonry: must<HTMLElement>('[data-matrix-group="masonry"]')
  };
}

function showGroup(els: ControlElements, kind: MatrixSpec['kind']): void {
  els.groupGrid.hidden = kind !== 'grid';
  els.groupJustified.hidden = kind !== 'justified';
  els.groupMasonry.hidden = kind !== 'masonry';
}

function readSpec(els: ControlElements): MatrixSpec {
  if (els.modeJustified.checked) {
    return { kind: 'justified', param: numericValue(els.height, FLOW_DEFAULTS.justified) };
  }
  if (els.modeMasonry.checked) {
    return { kind: 'masonry', param: numericValue(els.mcols, FLOW_DEFAULTS.masonry) };
  }
  return {
    kind: 'grid',
    rows: clampDim(numericValue(els.rows, 1)),
    cols: clampDim(numericValue(els.cols, 1))
  };
}

function numericValue(input: HTMLInputElement, fallback: number): number {
  const n = Number(input.value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Wire the controls. onChange is called whenever the author touches a
 * radio or spinbox, with the wire-format string ready to ship via
 * commitFigureAttr. */
export function mountMatrixControl(
  root: HTMLElement,
  onChange: (raw: string) => void
): MatrixControl {
  const els = findElements(root);
  let suppress = false;

  const emit = (): void => {
    if (suppress) return;
    onChange(serializeMatrix(readSpec(els)));
  };

  const onModeChange = (kind: MatrixSpec['kind']) => () => {
    showGroup(els, kind);
    emit();
  };

  els.modeGrid.addEventListener('change', onModeChange('grid'));
  els.modeJustified.addEventListener('change', onModeChange('justified'));
  els.modeMasonry.addEventListener('change', onModeChange('masonry'));
  for (const input of [els.rows, els.cols, els.height, els.mcols]) {
    input.addEventListener('change', emit);
  }

  return {
    setFromRaw(raw: string): void {
      const spec = parseMatrix(raw);
      suppress = true;
      try {
        if (spec.kind === 'grid') {
          els.modeGrid.checked = true;
          els.rows.value = String(spec.rows);
          els.cols.value = String(spec.cols);
          showGroup(els, 'grid');
        } else if (spec.kind === 'justified') {
          els.modeJustified.checked = true;
          els.height.value = String(spec.param);
          showGroup(els, 'justified');
        } else {
          els.modeMasonry.checked = true;
          els.mcols.value = String(spec.param);
          showGroup(els, 'masonry');
        }
      } finally {
        suppress = false;
      }
    }
  };
}
