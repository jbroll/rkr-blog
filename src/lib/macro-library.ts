// File-backed macro library. Each macro is a pretty-printed JSON file:
// { defaults, fieldSchema?, tree }. A macro whose tree is itself a macro
// instance is curried: it fixes some slots of another macro and leaves
// the rest open. The `page` macro holds site-wide chrome defaults,
// replacing config/site.json on the experimental JSON-pages path.

import fs from 'node:fs';
import path from 'node:path';

import { type BlockNode, resolveSlots, type Slots } from './blocks.ts';

export interface FieldSpec {
  label: string;
  type: 'text' | 'markdown' | 'image' | 'link' | 'select';
  default?: unknown;
  options?: string[];
}

export interface StoredMacro {
  defaults: Slots;
  fieldSchema?: Record<string, FieldSpec>;
  tree: BlockNode;
}

export type MacroLib = Map<string, StoredMacro>;

const KNOWN_TYPES: ReadonlySet<string> = new Set([
  'section',
  'row',
  'col',
  'flow',
  'text',
  'figure',
  'video',
  'button',
  'list',
  'marquee',
  'accordion',
  'progress',
  'embed',
  'macro'
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function checkNode(node: unknown): BlockNode {
  if (!isRecord(node) || typeof node.type !== 'string' || !KNOWN_TYPES.has(node.type)) {
    throw new Error(
      `macro-library: unknown block type ${(node as { type?: unknown }).type ?? '?'}`
    );
  }
  if (node.type === 'macro' && typeof node.macro !== 'string') {
    throw new Error('macro-library: macro instance needs a macro name');
  }
  return node as unknown as BlockNode;
}

/** Load every `*.json` file in `dir` as a macro, sorted by name. */
export function loadMacroLibrary(dir: string): MacroLib {
  const lib: MacroLib = new Map();
  if (!fs.existsSync(dir)) return lib;
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.json')) continue;
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`macro-library: ${file} is not valid JSON`);
    }
    if (!isRecord(parsed) || !isRecord(parsed.defaults)) {
      throw new Error(`macro-library: ${file} needs object defaults`);
    }
    const name = file.slice(0, -'.json'.length);
    lib.set(name, {
      defaults: parsed.defaults as Slots,
      fieldSchema: isRecord(parsed.fieldSchema)
        ? (parsed.fieldSchema as Record<string, FieldSpec>)
        : undefined,
      tree: checkNode(parsed.tree)
    });
  }
  return lib;
}

/** Site-wide chrome defaults: the slots of the root `page` macro. */
export function getRootDefaults(lib: MacroLib): Slots {
  return { ...(lib.get('page')?.defaults ?? {}) };
}

/** Expand one macro instance to a concrete node. Curried macros recurse
 * with fixed slots; explicit overrides always win over fixed slots. */
export function expandMacro(lib: MacroLib, name: string, overrides: Slots): BlockNode {
  const def = lib.get(name);
  if (!def) throw new Error(`macro-library: unknown macro ${name}`);
  if (def.tree.type === 'macro') {
    const fixed = isRecord(def.tree.slots) ? (def.tree.slots as Slots) : {};
    const inner = expandMacro(lib, def.tree.macro, { ...fixed, ...overrides });
    const merged = resolveSlots({ defaults: def.defaults }, overrides);
    return { ...inner, slots: { ...(inner.slots ?? {}), ...merged.slots } };
  }
  const merged = resolveSlots({ defaults: def.defaults }, overrides);
  return { ...def.tree, slots: merged.slots };
}
