import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { coverageOptions } from '../e2e/coverage-config.ts';

const { sourceFilter, sourcePath } = coverageOptions;

const resolve = (distFile: string, url: string): string =>
  sourcePath('ignored', { distFile, url }) as string;

describe('e2e coverage config', () => {
  it('maps both admin bundle URL forms to the same repo path', () => {
    const url = '../../src/admin/toast.ts';
    assert.equal(resolve('127.0.0.1-3789/static/admin/main.js', url), 'src/admin/toast.ts');
    assert.equal(resolve('127.0.0.1-3789/admin/static/admin/main.js', url), 'src/admin/toast.ts');
  });

  it('maps workspace canvas sources to their package path', () => {
    assert.equal(
      resolve(
        '127.0.0.1-3789/static/admin/main.js',
        '../../packages/image-edit/src/canvas/canvas.ts'
      ),
      'packages/image-edit/src/canvas/canvas.ts'
    );
  });

  it('keeps our sources and the canvas layer', () => {
    assert.ok(sourceFilter('src/admin/toast.ts'));
    assert.ok(sourceFilter('src/lib/figure-ids.ts'));
    assert.ok(sourceFilter('src/site/carousel.ts'));
    assert.ok(sourceFilter('packages/image-edit/src/canvas/canvas.ts'));
  });

  it('drops dependencies whose own layout contains a kept prefix', () => {
    assert.equal(sourceFilter('node_modules/@tiptap/core/src/lib/ResizableNodeView.ts'), false);
    assert.equal(sourceFilter('node_modules/prosemirror-model/dist/index.js'), false);
  });
});
