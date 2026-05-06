import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type DirectiveNode, type Widget, WidgetRegistry } from '../../src/lib/widgets.ts';

function leaf(name: string, attrs: Record<string, string> = {}): DirectiveNode {
  return { type: 'leafDirective', name, attributes: attrs, children: [] };
}

function makeWidget(name: string, render: Widget['render']): Widget {
  return { name, render };
}

test('register / has / get round-trip', () => {
  const reg = new WidgetRegistry();
  assert.equal(reg.has('image'), false);
  assert.equal(reg.get('image'), undefined);

  const w = makeWidget('image', () => '<picture/>');
  reg.register(w);

  assert.equal(reg.has('image'), true);
  assert.equal(reg.get('image'), w);
});

test('dispatch invokes the widget render and returns its output', async () => {
  const reg = new WidgetRegistry();
  reg.register(
    makeWidget('caption', (node) => `<figcaption>${node.attributes?.text ?? ''}</figcaption>`)
  );
  const html = await reg.dispatch('caption', leaf('caption', { text: 'Hi' }), {
    siteRoot: '/dev/null',
    widgets: reg
  });
  assert.equal(html, '<figcaption>Hi</figcaption>');
});

test('dispatch supports async renders', async () => {
  const reg = new WidgetRegistry();
  reg.register(
    makeWidget('async', async () => {
      await Promise.resolve();
      return '<async/>';
    })
  );
  const html = await reg.dispatch('async', leaf('async'), { siteRoot: '/dev/null', widgets: reg });
  assert.equal(html, '<async/>');
});

test('dispatch on an unknown widget emits a comment instead of throwing', async () => {
  const reg = new WidgetRegistry();
  const html = await reg.dispatch('nope', leaf('nope'), { siteRoot: '/dev/null', widgets: reg });
  assert.match(html, /<!-- unknown widget: nope -->/);
});
