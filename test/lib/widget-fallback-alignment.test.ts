// The figure widget's `variants × outputs` × `fallback` declaration
// is the source of truth for what URLs the rendered HTML emits. Each
// must round-trip through DEFAULT_VARIANTS × DEFAULT_OUTPUTS in
// originals.ts so the sidecar declares what /img/ later needs to
// serve. Cheap constants check; would have caught the original
// alignment bug.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_OUTPUTS, DEFAULT_VARIANTS } from '../../src/lib/originals.ts';
import * as figureWidget from '../../src/widgets/figure.ts';

const SRCSET_QUALITY: Record<string, number> = { webp: 85, avif: 70 };

function widthDeclared(w: number): boolean {
  return DEFAULT_VARIANTS.some((v) => v.w === w);
}
function outputDeclared(format: string, quality: number): boolean {
  return DEFAULT_OUTPUTS.some((o) => o.format === format && o.quality === quality);
}

test(`widget 'figure': fallback (w=${figureWidget.fallback.w}, ${figureWidget.fallback.format} q=${figureWidget.fallback.quality}) is in DEFAULT_VARIANTS × DEFAULT_OUTPUTS`, () => {
  const fb = figureWidget.fallback;
  assert.ok(widthDeclared(fb.w), `figure fallback w=${fb.w} not in DEFAULT_VARIANTS`);
  assert.ok(
    outputDeclared(fb.format, fb.quality),
    `figure fallback ${fb.format}@${fb.quality} not in DEFAULT_OUTPUTS`
  );
});

test(`widget 'figure': every srcset (variant, output) is declared`, () => {
  for (const v of figureWidget.variants) {
    assert.ok(widthDeclared(v.w), `figure srcset w=${v.w} not in DEFAULT_VARIANTS`);
    for (const fmt of v.formats) {
      const q = SRCSET_QUALITY[fmt];
      assert.ok(q !== undefined, `figure srcset format=${fmt} has no SRCSET_QUALITY mapping`);
      assert.ok(outputDeclared(fmt, q), `figure srcset ${fmt}@${q} not in DEFAULT_OUTPUTS`);
    }
  }
});
