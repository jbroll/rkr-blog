import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BlockTree } from '../../src/lib/blocks.ts';
import {
  collectBlockFigureIds,
  type RenderMacroLib,
  renderBlockTree
} from '../../src/lib/blocks-render.ts';
import type { ImageMap } from '../../src/lib/image-map.ts';
import { loadMacroLibrary, seedMacrosDir } from '../../src/lib/macro-library.ts';
import type { VideoMapView } from '../../src/lib/widgets.ts';
import { WidgetRegistry } from '../../src/lib/widgets.ts';

const emptyLib: RenderMacroLib = { get: () => undefined };

const fakeCtx = {
  images: new Map() as ImageMap,
  videos: new Map() as VideoMapView,
  widgets: new WidgetRegistry()
};

/** Marker comments in document order; each is the node's tree path. */
function markerPaths(html: string): number[][] {
  return [...html.matchAll(/<!--rkr:path=([0-9,]+)-->/g)].map((m) =>
    (m[1] as string).split(',').map(Number)
  );
}

const mark = (p: number[]): string => `<!--rkr:path=${p.join(',')}-->`;

const sectionWithHello: BlockTree = {
  version: 1,
  body: [
    {
      type: 'grid',
      slots: { cols: 1, band: true },
      children: [
        {
          type: 'grid',
          slots: { cols: 2 },
          children: [
            { type: 'grid', slots: { cols: 1 }, children: [{ type: 'text', markdown: 'Hello' }] }
          ]
        }
      ]
    }
  ]
};

describe('blocks-render', () => {
  it('renders a section band holding a grid of text', async () => {
    const html = await renderBlockTree(sectionWithHello, fakeCtx, emptyLib);
    assert.match(html, /rkr-section.*rkr-grid.*Hello/s);
  });

  it('renders text markdown bold', async () => {
    const tree: BlockTree = {
      version: 1,
      body: [{ type: 'text', markdown: 'a **b** c' }]
    };
    const html = await renderBlockTree(tree, fakeCtx, emptyLib);
    assert.match(html, /<strong>b<\/strong>/);
  });

  it('renders unknown macro as comment, not 500', async () => {
    const tree: BlockTree = {
      version: 1,
      body: [{ type: 'macro', macro: 'nope' }]
    };
    const html = await renderBlockTree(tree, fakeCtx, emptyLib);
    assert.match(html, /<!-- unknown macro: nope -->/);
  });

  it('renders macro cycle as comment', async () => {
    const cyclicLib: RenderMacroLib = {
      get: (name: string) =>
        name === 'hero' ? { defaults: {}, tree: { type: 'macro', macro: 'hero' } } : undefined
    };
    const tree: BlockTree = { version: 1, body: [{ type: 'macro', macro: 'hero' }] };
    const html = await renderBlockTree(tree, fakeCtx, cyclicLib);
    assert.match(html, /<!-- macro cycle: hero -->/);
  });

  it('renders button leaf as anchor', async () => {
    const tree: BlockTree = {
      version: 1,
      body: [{ type: 'button', slots: { label: 'Join', href: '/join', variant: 'primary' } }]
    };
    const html = await renderBlockTree(tree, fakeCtx, emptyLib);
    assert.match(html, /<a[^>]*href="\/join"[^>]*>Join<\/a>/);
  });

  it('renders marquee, accordion, and progress leaves with escaped text', async () => {
    const tree: BlockTree = {
      version: 1,
      body: [
        { type: 'marquee', slots: { text: 'Big <news>' } },
        { type: 'accordion', slots: { items: [{ title: 'Q?', body: 'A & B' }, null] } },
        { type: 'progress', slots: { goal: 200, raised: 50 } },
        { type: 'progress', slots: { raised: 50 } }
      ]
    };
    const html = await renderBlockTree(tree, fakeCtx, emptyLib);
    assert.match(html, /<div class="rkr-marquee"><span>Big &lt;news&gt;<\/span><\/div>/);
    assert.match(html, /<summary>Q\?<\/summary>\nA &amp; B\n<\/details>/);
    assert.match(html, /<details><summary><\/summary>/);
    assert.match(html, /aria-valuenow="25"[^>]*><div class="rkr-progress-bar" style="width: 25%">/);
    assert.match(html, /aria-valuenow="0"/);
  });

  it('embeds allowed hosts, links others, and comments out invalid urls', async () => {
    const tree: BlockTree = {
      version: 1,
      body: [
        { type: 'embed', slots: { url: 'https://www.youtube.com/embed/x' } },
        { type: 'embed', slots: { url: 'https://example.com/page' } },
        { type: 'embed', slots: { url: 'not a url' } }
      ]
    };
    const html = await renderBlockTree(tree, fakeCtx, emptyLib);
    assert.match(html, /<iframe class="rkr-embed" src="https:\/\/www\.youtube\.com\/embed\/x"/);
    assert.match(html, /<a href="https:\/\/example\.com\/page">https:\/\/example\.com\/page<\/a>/);
    assert.match(html, /<!-- embed: invalid url -->/);
  });

  it('markers zip with source order, public output unchanged without mark', async () => {
    // Two top-level leaves then a section wrapping two leaves (a
    // section>… nesting: each child appends its index to the parent path).
    const tree: BlockTree = {
      version: 1,
      body: [
        { type: 'text', markdown: 'One' },
        { type: 'text', markdown: 'Two' },
        {
          type: 'grid',
          slots: { cols: 1, band: true },
          children: [
            { type: 'text', markdown: 'Three' },
            { type: 'text', markdown: 'Four' }
          ]
        }
      ]
    };
    const plain = await renderBlockTree(tree, fakeCtx, emptyLib);
    // Today's public output, byte-for-byte.
    assert.equal(
      plain,
      '<p>One</p>\n<p>Two</p>\n<section class="rkr-section rkr-theme-light">\n<div class="rkr-section-inner rkr-grid" style="--rkr-grid-cols:1;--rkr-grid-min:16rem">\n<div class="rkr-grid-cell"><p>Three</p>\n</div>\n<div class="rkr-grid-cell"><p>Four</p>\n</div>\n</div>\n</section>\n'
    );

    const marked = await renderBlockTree(tree, fakeCtx, emptyLib, { mark });
    // Markers and the grid label are the only editor additions.
    assert.equal(
      marked.replace(/<!--rkr:path=[0-9,]+-->/g, '').replace(/ data-rkr-grid-label="[^"]*"/g, ''),
      plain
    );
    // Document order === source order; the section itself is a node
    // ([2]) as well as its children ([2,0], [2,1]) so the client zip
    // matches the source-tree flattening.
    assert.deepEqual(markerPaths(marked), [[0], [1], [2], [2, 0], [2, 1]]);
  });

  it('macro instance emits one marker (internals unmarked)', async () => {
    const macroLib: RenderMacroLib = {
      get: (name: string) =>
        name === 'hero'
          ? {
              defaults: {},
              tree: {
                type: 'grid',
                slots: { cols: 1, band: true },
                children: [
                  {
                    type: 'grid',
                    slots: { cols: 2 },
                    children: [
                      {
                        type: 'grid',
                        slots: { cols: 1 },
                        children: [{ type: 'text', markdown: 'Hero' }]
                      }
                    ]
                  }
                ]
              }
            }
          : undefined
    };
    const tree: BlockTree = {
      version: 1,
      body: [
        { type: 'macro', macro: 'hero' },
        { type: 'text', markdown: 'After' }
      ]
    };
    const plain = await renderBlockTree(tree, fakeCtx, macroLib);
    const marked = await renderBlockTree(tree, fakeCtx, macroLib, { mark });
    assert.equal(marked.replace(/<!--rkr:path=[0-9,]+-->/g, ''), plain);
    assert.deepEqual(markerPaths(marked), [[0], [1]]);
    assert.match(marked, /Hero/);
  });

  it('blank text emits an edit placeholder only when marking', async () => {
    const blank: BlockTree = { version: 1, body: [{ type: 'text', markdown: '' }] };
    const marked = await renderBlockTree(blank, fakeCtx, emptyLib, { mark });
    assert.ok(marked.includes('<!--rkr:path=0-->'));
    assert.ok(marked.includes('data-rkr-blank'));
    assert.equal(await renderBlockTree(blank, fakeCtx, emptyLib), '');
  });

  it('blank text keeps sibling markers aligned and public output unchanged', async () => {
    const tree: BlockTree = {
      version: 1,
      body: [
        { type: 'text', markdown: '' },
        { type: 'text', markdown: 'Hi' },
        { type: 'button', slots: { label: 'Go', href: '/go' } }
      ]
    };
    const plain = await renderBlockTree(tree, fakeCtx, emptyLib);
    const marked = await renderBlockTree(tree, fakeCtx, emptyLib, { mark });
    assert.equal(
      marked.replace(/<!--rkr:path=[0-9,]+-->|<p class="rkr-unified-blank"[^>]*><\/p>\n?/g, ''),
      plain
    );
    assert.deepEqual(markerPaths(marked), [[0], [1], [2]]);
  });

  it('collects figure ids including inside macros', () => {
    const tree: BlockTree = {
      version: 1,
      body: [
        { type: 'figure', slots: { ids: 'aa11, bb22' } },
        { type: 'macro', macro: 'wall' }
      ]
    };
    assert.deepEqual(collectBlockFigureIds(tree), ['aa11, bb22']);
    assert.deepEqual(
      collectBlockFigureIds(tree, {
        get: (n) =>
          n === 'wall'
            ? { defaults: {}, tree: { type: 'figure', slots: { ids: 'cc33' } } }
            : undefined
      }),
      ['aa11, bb22', 'cc33']
    );
    // Cycles terminate.
    assert.deepEqual(
      collectBlockFigureIds(
        { version: 1, body: [{ type: 'macro', macro: 'loop' }] },
        { get: () => ({ defaults: {}, tree: { type: 'macro', macro: 'loop' } }) }
      ),
      []
    );
  });

  it('collects the ids each macro instance fills into an image placeholder', () => {
    const lib: RenderMacroLib = {
      get: (n) =>
        n === 'split'
          ? {
              defaults: { image: 'dd44' },
              tree: { type: 'grid', children: [{ type: 'figure', slots: { ids: '{{image}}' } }] }
            }
          : undefined
    };
    const tree: BlockTree = {
      version: 1,
      body: [
        { type: 'macro', macro: 'split', slots: { image: 'aa11' } },
        { type: 'macro', macro: 'split', slots: { image: 'bb22' } },
        { type: 'macro', macro: 'split' }
      ]
    };
    assert.deepEqual(collectBlockFigureIds(tree, lib), ['aa11', 'bb22', 'dd44']);
  });

  describe('seeded macros', () => {
    const lib = loadMacroLibrary(seedMacrosDir());
    const renderLib: RenderMacroLib = { get: (n) => lib.get(n) };
    const render = (macro: string, slots: Record<string, string>) =>
      renderBlockTree({ version: 1, body: [{ type: 'macro', macro, slots }] }, fakeCtx, renderLib);

    it('macro instance slots override defaults', async () => {
      const html = await render('hero', { heading: 'Probe hero heading' });
      assert.match(html, /Probe hero heading/);
      assert.doesNotMatch(html, /Fresh food, owned by neighbors/);
      assert.match(html, /community grocery/);
    });

    it('macro defaults render when no override is set', async () => {
      const html = await render('hero', {});
      assert.match(html, /Fresh food, owned by neighbors/);
      assert.match(html, /rkr-theme-dark/);
    });

    it('every fieldSchema field of every placeable macro reaches the output', async () => {
      for (const [name, def] of lib) {
        if (name === 'page') continue;
        for (const key of Object.keys(def.fieldSchema ?? {})) {
          const probe = `Probe ${name} ${key}`;
          const html = await render(name, { [key]: probe });
          assert.ok(html.includes(probe), `${name}.${key} does not render`);
        }
      }
    });

    it('unresolved placeholders render empty', async () => {
      const odd: RenderMacroLib = {
        get: (n) =>
          n === 'odd'
            ? {
                defaults: { list: ['a', 'b'] },
                tree: { type: 'text', markdown: 'A{{missing}}B{{list}}C' }
              }
            : undefined
      };
      const html = await renderBlockTree(
        { version: 1, body: [{ type: 'macro', macro: 'odd' }] },
        fakeCtx,
        odd
      );
      assert.doesNotMatch(html, /\{\{/);
      assert.match(html, /ABC/);
    });

    it('substitutes placeholders inside curried macros', async () => {
      const curried: RenderMacroLib = {
        get: (n) =>
          n === 'outer'
            ? {
                defaults: { t: 'dflt' },
                tree: { type: 'macro', macro: 'hero', slots: { heading: '{{t}}' } }
              }
            : renderLib.get(n)
      };
      const html = await renderBlockTree(
        { version: 1, body: [{ type: 'macro', macro: 'outer', slots: { t: 'Curried probe' } }] },
        fakeCtx,
        curried
      );
      assert.match(html, /Curried probe/);
    });
  });
});

describe('macro list slots, quiet buttons, class hook', () => {
  const lib = (
    name: string,
    tree: unknown,
    defaults: Record<string, unknown> = {}
  ): RenderMacroLib => ({
    get: (n) => (n === name ? { defaults, tree: tree as BlockTree['body'][number] } : undefined)
  });
  const one = (node: unknown): BlockTree => ({
    version: 1,
    body: [node as BlockTree['body'][number]]
  });
  const people = {
    type: 'grid',
    slots: { cols: 2, each: 'people' },
    children: [{ type: 'text', markdown: '## {{name}} {{site}}' }]
  };

  it('a button with an empty label renders nothing publicly and a placeholder when marked', async () => {
    const node = one({ type: 'button', slots: { label: '', href: '/x' } });
    assert.equal(await renderBlockTree(node, fakeCtx, emptyLib), '');
    assert.match(await renderBlockTree(node, fakeCtx, emptyLib, { mark }), /rkr-btn/);
  });

  it('an each grid renders its children once per list item, item slots first', async () => {
    const html = await renderBlockTree(
      one({
        type: 'macro',
        macro: 'board',
        slots: { people: [{ name: 'Ann' }, { name: 'Bo', site: 'Y' }], site: 'X' }
      }),
      fakeCtx,
      lib('board', people)
    );
    assert.match(html, /Ann X[\s\S]*Bo Y/);
    assert.equal((html.match(/class="rkr-grid-cell"/g) ?? []).length, 2);
    assert.doesNotMatch(html, /each/);
  });

  it('an empty or missing list renders the each grid empty (no cells)', async () => {
    const band = { type: 'grid', slots: { band: true }, children: [people] };
    for (const slots of [{ people: [] }, {}, { people: 'nope' }]) {
      const html = await renderBlockTree(
        one({ type: 'macro', macro: 'board', slots }),
        fakeCtx,
        lib('board', band)
      );
      assert.doesNotMatch(html, /rkr-grid-cell/);
    }
  });

  it('marks a macro instance whose expansion renders nothing', async () => {
    const cases: [string, unknown, Record<string, unknown>][] = [
      ['board', people, {}],
      ['cta', { type: 'button', slots: { label: '' } }, {}]
    ];
    for (const [name, tree, slots] of cases) {
      const node = one({ type: 'macro', macro: name, slots });
      assert.equal(await renderBlockTree(node, fakeCtx, lib(name, tree)), '');
      const marked = await renderBlockTree(node, fakeCtx, lib(name, tree), { mark });
      assert.deepEqual(markerPaths(marked), [[0]], name);
    }
  });

  it('collectBlockFigureIds returns image ids from list items', () => {
    const tree = {
      type: 'grid',
      slots: { each: 'people' },
      children: [{ type: 'figure', slots: { ids: '{{photo}}' } }]
    };
    assert.deepEqual(
      collectBlockFigureIds(
        one({
          type: 'macro',
          macro: 'board',
          slots: { people: [{ photo: 'aaa' }, { photo: 'bbb' }] }
        }),
        lib('board', tree)
      ),
      ['aaa', 'bbb']
    );
  });

  it('macro root carries rkr-macro-<name>; a leaf root is wrapped in a div', async () => {
    const band = await renderBlockTree(
      one({ type: 'macro', macro: 'hero-band' }),
      fakeCtx,
      lib('hero-band', {
        type: 'grid',
        slots: { band: true },
        children: [{ type: 'text', markdown: 'x' }]
      })
    );
    assert.match(band, /^<section class="rkr-section rkr-theme-light rkr-macro-hero-band">/);
    const grid = await renderBlockTree(
      one({ type: 'macro', macro: 'cards' }),
      fakeCtx,
      lib('cards', {
        type: 'grid',
        slots: { cols: 2 },
        children: [{ type: 'text', markdown: 'x' }]
      })
    );
    assert.match(grid, /^<div class="rkr-grid rkr-macro-cards"/);
    const stacked = await renderBlockTree(
      one({ type: 'macro', macro: 'split' }),
      fakeCtx,
      lib('split', {
        type: 'grid',
        slots: { cols: 2, widths: '2 1' },
        children: [{ type: 'text', markdown: 'x' }]
      })
    );
    assert.match(stacked, /^<div class="rkr-grid-wrap rkr-macro-split">/);
    const leaf = await renderBlockTree(
      one({ type: 'macro', macro: 'note' }),
      fakeCtx,
      lib('note', { type: 'text', markdown: 'Hi' })
    );
    assert.equal(leaf, '<div class="rkr-macro-note"><p>Hi</p>\n</div>\n');
    const quiet = await renderBlockTree(
      one({ type: 'macro', macro: 'cta' }),
      fakeCtx,
      lib('cta', { type: 'button', slots: { label: '' } })
    );
    assert.equal(quiet, '');
    const odd = await renderBlockTree(
      one({ type: 'macro', macro: 'Bad Name' }),
      fakeCtx,
      lib('Bad Name', { type: 'text', markdown: 'Hi' })
    );
    assert.equal(odd, '<p>Hi</p>\n');
  });
});

describe('renderBlockTree unknown types', () => {
  it('renders nothing for an unknown nested type and warns instead of throwing', async (t) => {
    const warned: string[] = [];
    t.mock.method(console, 'warn', (...a: unknown[]) => {
      warned.push(a.map(String).join(' '));
    });
    const lib: RenderMacroLib = {
      get: (n) =>
        n === 'odd'
          ? {
              defaults: {},
              tree: {
                type: 'grid',
                slots: { cols: 1, band: true },
                children: [{ type: 'mystery' } as never, { type: 'text', markdown: 'Kept' }]
              }
            }
          : undefined
    };
    const html = await renderBlockTree(
      { version: 1, body: [{ type: 'macro', macro: 'odd' }] },
      fakeCtx,
      lib
    );
    assert.match(html, /Kept/);
    assert.doesNotMatch(html, /mystery/);
    assert.match(warned.join('\n'), /unknown block type mystery/);
  });

  describe('grid', () => {
    const grid = (
      slots: Record<string, unknown>,
      children: unknown[] = [{ type: 'text', markdown: 'x' }]
    ) => ({ version: 1, body: [{ type: 'grid', slots, children }] }) as BlockTree;
    const render = (tree: BlockTree, mk?: boolean) =>
      renderBlockTree(tree, fakeCtx, emptyLib, mk ? { mark } : undefined);

    it('renders columns and minimum cell width as custom properties', async () => {
      const html = await render(grid({ cols: 3 }));
      assert.match(html, /class="rkr-grid" style="--rkr-grid-cols:3;--rkr-grid-min:16rem"/);
    });

    it('renders widths as fr tracks inside a collapse wrapper', async () => {
      const html = await render(grid({ cols: 2, widths: '2 1', min: 'narrow' }));
      assert.match(html, /--rkr-grid-widths:2fr 1fr/);
      assert.match(html, /data-widths/);
      assert.match(html, /<div class="rkr-grid-wrap"><div class="rkr-grid rkr-collapse-2-narrow"/);
    });

    it('falls back to one column for a bad cols value', async () => {
      assert.match(await render(grid({ cols: 'x' })), /--rkr-grid-cols:1;/);
    });

    it('rounds a fractional cols value', async () => {
      assert.match(await render(grid({ cols: 2.5 })), /--rkr-grid-cols:3;/);
    });

    it('renders a band with theme and wave edge', async () => {
      const html = await render(grid({ band: true, theme: 'dark', edge: 'wave' }));
      assert.match(html, /<section class="rkr-section rkr-theme-dark">/);
      assert.match(html, /rkr-section-inner rkr-grid/);
      assert.match(html, /rkr-section-wave/);
    });

    it('puts one text block with a heading and a paragraph in one cell', async () => {
      const html = await render(
        grid({ cols: 2 }, [{ type: 'text', markdown: '## Head\n\nBody.' }])
      );
      assert.equal((html.match(/rkr-grid-cell/g) ?? []).length, 1);
    });

    it('renders one cell per figure', async () => {
      const fig = { type: 'figure', slots: { ids: 'aaaa1111' } };
      const widgets = new WidgetRegistry();
      widgets.register({ name: 'figure', render: () => '<figure></figure>\n' });
      const html = await renderBlockTree(
        grid({ cols: 3 }, [fig, fig, fig]),
        { ...fakeCtx, widgets },
        emptyLib
      );
      assert.equal((html.match(/class="rkr-grid-cell"/g) ?? []).length, 3);
    });

    it('places the marker inside the cell', async () => {
      const html = await render(grid({ cols: 2 }), true);
      assert.match(html, /<div class="rkr-grid-cell"><!--rkr:path=0,0--><p>x<\/p>/);
    });

    it('renders nothing for an empty grid on the public page', async () => {
      assert.equal(await render(grid({ cols: 2 }, [])), '');
    });

    it('gives readers no cell for a child that renders only a comment', async () => {
      const kids = [
        { type: 'text', markdown: 'x' },
        { type: 'macro', macro: 'gone' }
      ];
      const html = await render(grid({ cols: 2 }, kids));
      assert.equal((html.match(/class="rkr-grid-cell"/g) ?? []).length, 1);
      assert.match(html, /<!-- unknown macro: gone -->/);
      assert.doesNotMatch(html, /rkr-grid-cell"><!-- unknown macro/);
    });

    it('renders only the comments when no child of a public grid renders an element', async () => {
      const html = await render(grid({ cols: 2 }, [{ type: 'macro', macro: 'gone' }]));
      assert.equal(html, '<!-- unknown macro: gone -->');
    });

    it('keeps a cell for a comment-only child in the editor', async () => {
      const kids = [
        { type: 'text', markdown: 'x' },
        { type: 'macro', macro: 'gone' }
      ];
      const html = await render(grid({ cols: 2 }, kids), true);
      assert.equal((html.match(/class="rkr-grid-cell"/g) ?? []).length, 2);
      assert.match(
        html,
        /<div class="rkr-grid-cell"><!--rkr:path=0,1--><!-- unknown macro: gone --><\/div>/
      );
    });

    it('renders a labelled placeholder for an empty grid in the editor', async () => {
      const html = await render(grid({ cols: 2 }, []), true);
      assert.match(html, /data-rkr-grid-label="Row \(2 columns\)"/);
      assert.match(
        html,
        /<p class="rkr-grid-empty" data-rkr-grid-empty>Empty grid: drag blocks here<\/p>/
      );
    });
  });
});
