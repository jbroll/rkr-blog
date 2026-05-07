// Widget registry. Widgets implement custom directives (`::name{attrs}`)
// in post markdown — for now `::image{...}`; gallery arrives in Step 8.
// See spec.md §9 image widgets.

import type { Parent, PhrasingContent } from 'mdast';

export interface DirectiveNode extends Parent {
  type: 'leafDirective' | 'textDirective' | 'containerDirective';
  name: string;
  attributes?: Record<string, string | null | undefined>;
  children: PhrasingContent[];
}

export interface WidgetCtx {
  siteRoot: string;
  widgets: WidgetRegistry;
}

export interface VariantSpec {
  w: number;
  formats: string[];
}

export interface FallbackSpec {
  w: number;
  format: string;
  quality: number;
}

export interface Widget {
  name: string;
  variants?: VariantSpec[];
  fallback?: FallbackSpec;
  validate?(
    rawAttrs: Record<string, string | null | undefined>
  ): { ok: true; attrs: Record<string, unknown> } | { ok: false; error: string };
  render(node: DirectiveNode, ctx: WidgetCtx): string | Promise<string>;
}

export class WidgetRegistry {
  private widgets = new Map<string, Widget>();

  register(w: Widget): void {
    this.widgets.set(w.name, w);
  }

  has(name: string): boolean {
    return this.widgets.has(name);
  }

  get(name: string): Widget | undefined {
    return this.widgets.get(name);
  }

  /** Render a directive. Unknown widgets emit a comment so authoring errors are visible. */
  async dispatch(name: string, node: DirectiveNode, ctx: WidgetCtx): Promise<string> {
    const w = this.widgets.get(name);
    if (!w) return `<!-- unknown widget: ${escapeComment(name)} -->`;
    return await w.render(node, ctx);
  }
}

function escapeComment(s: string): string {
  return s.replace(/--/g, '- -').slice(0, 80);
}
