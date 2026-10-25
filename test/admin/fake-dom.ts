// Minimal fake DOM shared by admin client tests.
// The repo has no jsdom/happy-dom (see source-picker.test.ts), so this
// covers exactly what the admin client modules use: element/comment/text
// nodes, attributes, classList, dataset, bubbling listeners,
// querySelector for simple selectors, and click/focus dispatch.

export type Listener = (ev: FakeEvent) => void;

export class FakeEvent {
  readonly type: string;
  readonly bubbles: boolean;
  target: FakeNode | null = null;
  currentTarget: FakeNode | null = null;
  defaultPrevented = false;
  stopped = false;

  constructor(type: string, init: { bubbles?: boolean } = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? true;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.stopped = true;
  }
}

export class FakeNode {
  readonly nodeType: number;
  nodeValue: string | null = null;
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(nodeType: number) {
    this.nodeType = nodeType;
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  get nextSibling(): FakeNode | null {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[i + 1] ?? null;
  }

  get textContent(): string {
    if (this.nodeType === 3 || this.nodeType === 8) return this.nodeValue ?? '';
    return this.childNodes.map((c) => c.textContent).join('');
  }

  set textContent(value: string) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    if (value !== '') {
      const text = new FakeNode(3);
      text.nodeValue = value;
      this.append(text);
    }
  }

  append(...nodes: FakeNode[]): void {
    for (const node of nodes) {
      node.parentNode?.removeChild(node);
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }

  prepend(...nodes: FakeNode[]): void {
    nodes.forEach((node, i) => {
      node.parentNode?.removeChild(node);
      node.parentNode = this;
      this.childNodes.splice(i, 0, node);
    });
  }

  insertBefore(node: FakeNode, ref: FakeNode | null): void {
    const at = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, node);
  }

  removeChild(node: FakeNode): void {
    const at = this.childNodes.indexOf(node);
    if (at >= 0) this.childNodes.splice(at, 1);
    node.parentNode = null;
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(ev: FakeEvent): boolean {
    ev.target ??= this;
    let node: FakeNode | null = this;
    while (node) {
      ev.currentTarget = node;
      for (const listener of [...(node.listeners.get(ev.type) ?? [])]) listener(ev);
      if (!ev.bubbles || ev.stopped) break;
      node = node.parentNode;
    }
    return !ev.defaultPrevented;
  }

  querySelectorAll(_selector: string): FakeElement[] {
    return [];
  }

  querySelector(_selector: string): FakeElement | null {
    return null;
  }
}

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function matches(el: FakeElement, selector: string): boolean {
  if (selector.startsWith('#')) return el.id === selector.slice(1);
  if (selector.startsWith('.')) return el.classList.contains(selector.slice(1));
  if (selector.startsWith('[') && selector.endsWith(']')) {
    const body = selector.slice(1, -1);
    const eq = body.indexOf('=');
    if (eq < 0) return el.hasAttribute(body);
    const value = body
      .slice(eq + 1)
      .replace(/^["']|["']$/g, '')
      .trim();
    return el.getAttribute(body.slice(0, eq)) === value;
  }
  return el.tagName === selector.toUpperCase();
}

export class FakeElement extends FakeNode {
  readonly tagName: string;
  readonly ownerDocument: FakeDocument;
  readonly attributes = new Map<string, string>();
  readonly classList: {
    add(...names: string[]): void;
    remove(...names: string[]): void;
    contains(name: string): boolean;
    toggle(name: string, force?: boolean): boolean;
  };
  readonly dataset: Record<string, string>;
  type = '';

  constructor(tag: string, doc: FakeDocument) {
    super(1);
    this.tagName = tag.toUpperCase();
    this.ownerDocument = doc;
    this.classList = {
      add: (...names: string[]) => {
        for (const n of names) this.attributes.set('class', this.classNames(n, true).join(' '));
      },
      remove: (...names: string[]) => {
        for (const n of names) this.attributes.set('class', this.classNames(n, false).join(' '));
      },
      contains: (name: string) => this.classNames().includes(name),
      toggle: (name: string, force?: boolean) => {
        const on = force ?? !this.classNames().includes(name);
        this.attributes.set('class', this.classNames(name, on).join(' '));
        return on;
      }
    };
    this.dataset = new Proxy({} as Record<string, string>, {
      get: (_target, prop) => this.attributes.get(`data-${kebab(String(prop))}`),
      set: (_target, prop, value) => {
        this.attributes.set(`data-${kebab(String(prop))}`, String(value));
        return true;
      },
      deleteProperty: (_target, prop) => {
        this.attributes.delete(`data-${kebab(String(prop))}`);
        return true;
      },
      has: (_target, prop) => this.attributes.has(`data-${kebab(String(prop))}`)
    });
  }

  private classNames(change?: string, on = true): string[] {
    const current = (this.attributes.get('class') ?? '').split(/\s+/).filter(Boolean);
    if (!change) return current;
    const without = current.filter((c) => c !== change);
    return on ? [...without, change] : without;
  }

  get id(): string {
    return this.attributes.get('id') ?? '';
  }

  set id(value: string) {
    this.attributes.set('id', value);
  }

  get className(): string {
    return this.attributes.get('class') ?? '';
  }

  set className(value: string) {
    this.attributes.set('class', value);
  }

  get hidden(): boolean {
    return this.attributes.has('hidden');
  }

  set hidden(value: boolean) {
    if (value) this.attributes.set('hidden', '');
    else this.attributes.delete('hidden');
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  after(node: FakeNode): void {
    if (!this.parentNode) return;
    this.parentNode.insertBefore(node, this.nextSibling);
  }

  get innerHTML(): string {
    return this.childNodes.map(serialize).join('');
  }

  set innerHTML(html: string) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this.append(...parseHtml(this.ownerDocument, html));
  }

  click(): void {
    this.dispatchEvent(new FakeEvent('click'));
  }

  focus(): void {
    this.dispatchEvent(new FakeEvent('focus'));
  }

  override querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (node: FakeNode): void => {
      for (const child of node.childNodes) {
        if (child instanceof FakeElement) {
          if (matches(child, selector)) out.push(child);
          walk(child);
        }
      }
    };
    walk(this);
    return out;
  }

  override querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  closest(selector: string): FakeElement | null {
    let node: FakeNode | null = this;
    while (node) {
      if (node instanceof FakeElement && matches(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
}

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'source', 'wbr', 'meta', 'link']);
const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'"
};
const decode = (s: string): string => s.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);
const encode = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

/** Enough of an HTML parser for renderer output: tags, attributes,
 * comments, text, void elements. Input is assumed well-formed. */
function parseHtml(doc: FakeDocument, html: string): FakeNode[] {
  const top = doc.createElement('template');
  const stack: FakeElement[] = [top];
  const token =
    /<!--([\s\S]*?)-->|<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
  const attr = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const m of html.matchAll(token)) {
    const parent = stack[stack.length - 1] as FakeElement;
    if (m[1] !== undefined) parent.append(doc.createComment(m[1]));
    else if (m[2] !== undefined) {
      const tag = m[2].toUpperCase();
      const at = stack.map((e) => e.tagName).lastIndexOf(tag);
      if (at > 0) stack.length = at;
    } else if (m[3] !== undefined) {
      const el = doc.createElement(m[3]);
      for (const a of (m[4] ?? '').matchAll(attr)) {
        el.setAttribute(a[1] as string, decode(a[2] ?? a[3] ?? a[4] ?? ''));
      }
      parent.append(el);
      if (!m[5] && !VOID_TAGS.has(m[3].toLowerCase())) stack.push(el);
    } else if (m[6] !== undefined) parent.append(doc.createTextNode(decode(m[6])));
  }
  return [...top.childNodes];
}

function serialize(node: FakeNode): string {
  if (node.nodeType === 3) return encode(node.nodeValue ?? '');
  if (node.nodeType === 8) return `<!--${node.nodeValue ?? ''}-->`;
  const el = node as FakeElement;
  const tag = el.tagName.toLowerCase();
  const attrs = [...el.attributes].map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${encode(v)}"`));
  const open = `<${tag}${attrs.join('')}>`;
  return VOID_TAGS.has(tag) ? open : `${open}${el.innerHTML}</${tag}>`;
}

export class FakeDocument {
  activeElement: FakeElement | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  /** Runs document listeners after the target's own bubbling pass. */
  dispatchEvent(ev: FakeEvent): void {
    for (const listener of [...(this.listeners.get(ev.type) ?? [])]) listener(ev);
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }

  createComment(value: string): FakeNode {
    const node = new FakeNode(8);
    node.nodeValue = value;
    return node;
  }

  createTextNode(value: string): FakeNode {
    const node = new FakeNode(3);
    node.nodeValue = value;
    return node;
  }
}

export function marker(doc: FakeDocument, path: string): FakeNode {
  return doc.createComment(`rkr:path=${path}`);
}

export function para(doc: FakeDocument, value: string): FakeElement {
  const p = doc.createElement('p');
  p.textContent = value;
  return p;
}
/** Element builder: el(doc, 'p', { class: 'x' }, kid1, kid2, 'raw text'). */
export function el(
  doc: FakeDocument,
  tag: string,
  attrs: Record<string, string> = {},
  ...kids: Array<FakeNode | string>
): FakeElement {
  const element = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) element.setAttribute(k, v);
  for (const kid of kids) {
    element.append(typeof kid === 'string' ? doc.createTextNode(kid) : kid);
  }
  return element;
}
