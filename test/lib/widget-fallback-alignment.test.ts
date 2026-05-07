// Every widget URL the rendered HTML emits — both <img src> fallback
// and every <source srcset> entry — must point at a (variant, output)
// pair the sidecar declares at ingest time. Otherwise findVariantOutput
// in routes/public.ts can't reproduce the cacheKey, and /img/ 404s with
// "no matching variant" the first time it's requested.
//
// This is a constants-alignment test: imports both ends and asserts
// the relationship. Cheap to run; would have caught the bug where
// gallery's srcset emitted w:320 / w:640 widths but DEFAULT_VARIANTS
// only had {w:400/800/1600}, so no gallery image ever resolved.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_OUTPUTS, DEFAULT_VARIANTS } from '../../src/lib/originals.ts';
import * as carouselWidget from '../../src/widgets/carousel.ts';
import * as diptychWidget from '../../src/widgets/diptych.ts';
import * as galleryWidget from '../../src/widgets/gallery.ts';
import * as imageWidget from '../../src/widgets/image.ts';

// Each widget exposes `variants` + `fallback` as top-level exports;
// `name` isn't always at the top level (diptych also exports a
// triptych widget) so we label them here for assertion messages.
const widgets = [
  { name: 'image', variants: imageWidget.variants, fallback: imageWidget.fallback },
  { name: 'gallery', variants: galleryWidget.variants, fallback: galleryWidget.fallback },
  { name: 'carousel', variants: carouselWidget.variants, fallback: carouselWidget.fallback },
  { name: 'diptych', variants: diptychWidget.variants, fallback: diptychWidget.fallback }
] as const;

// Quality used for non-jpeg srcset entries. widget-helpers.ts derives
// this from QUALITY_BY_FORMAT — we mirror it here so the test stays
// independent of helper internals. Drift between the two would surface
// as a srcset URL not resolving on a real fetch.
const SRCSET_QUALITY: Record<string, number> = { webp: 85, avif: 70 };

function widthDeclared(w: number): boolean {
  return DEFAULT_VARIANTS.some((v) => v.w === w);
}

function outputDeclared(format: string, quality: number): boolean {
  return DEFAULT_OUTPUTS.some((o) => o.format === format && o.quality === quality);
}

for (const w of widgets) {
  test(`widget '${w.name}': fallback (w=${w.fallback.w}, ${w.fallback.format} q=${w.fallback.quality}) is in DEFAULT_VARIANTS × DEFAULT_OUTPUTS`, () => {
    const fb = w.fallback;
    assert.ok(
      widthDeclared(fb.w),
      `${w.name} fallback w=${fb.w} not in DEFAULT_VARIANTS=${JSON.stringify(DEFAULT_VARIANTS)}`
    );
    assert.ok(
      outputDeclared(fb.format, fb.quality),
      `${w.name} fallback ${fb.format}@${fb.quality} not in DEFAULT_OUTPUTS=${JSON.stringify(DEFAULT_OUTPUTS)}`
    );
  });

  test(`widget '${w.name}': every srcset (variant, output) is declared`, () => {
    for (const v of w.variants) {
      assert.ok(
        widthDeclared(v.w),
        `${w.name} srcset w=${v.w} not in DEFAULT_VARIANTS=${JSON.stringify(DEFAULT_VARIANTS)}`
      );
      for (const fmt of v.formats) {
        const q = SRCSET_QUALITY[fmt];
        assert.ok(
          q !== undefined,
          `${w.name} srcset format=${fmt} has no SRCSET_QUALITY mapping in this test`
        );
        assert.ok(
          outputDeclared(fmt, q),
          `${w.name} srcset ${fmt}@${q} not in DEFAULT_OUTPUTS=${JSON.stringify(DEFAULT_OUTPUTS)}`
        );
      }
    }
  });
}
