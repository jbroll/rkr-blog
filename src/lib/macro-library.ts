// File-backed macro library. Each macro is a pretty-printed JSON file:
// { defaults, fieldSchema?, tree }. A macro whose tree is itself a macro
// instance is curried: it fixes some slots of another macro and leaves
// the rest open.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type BlockNode,
  type FieldSpec,
  parseBlockTree,
  resolveSlots,
  type Slots
} from './blocks.ts';

export interface StoredMacro {
  /** One line for the editor palette. */
  description?: string;
  defaults: Slots;
  fieldSchema?: Record<string, FieldSpec>;
  tree: BlockNode;
}

export type MacroLib = Map<string, StoredMacro>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Structural logger so callers can pass Fastify's request log. */
interface MacroLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

const consoleLogger: MacroLogger = {
  // biome-ignore lint/suspicious/noConsole: CLI and render callers without a request log
  warn: (_obj, msg) => console.warn(msg)
};

/** One macro file, validated with the same node rules as a page tree. */
function readMacro(file: string, raw: string): StoredMacro {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`macro-library: ${file} is not valid JSON`);
  }
  if (!isRecord(parsed) || !isRecord(parsed.defaults)) {
    throw new Error(`macro-library: ${file} needs object defaults`);
  }
  let tree: BlockNode;
  try {
    tree = parseBlockTree({ version: 1, body: [parsed.tree] }).body[0] as BlockNode;
  } catch (err) {
    throw new Error(`macro-library: ${file}: ${(err as Error).message}`);
  }
  return {
    description: typeof parsed.description === 'string' ? parsed.description : undefined,
    defaults: parsed.defaults as Slots,
    fieldSchema: isRecord(parsed.fieldSchema)
      ? (parsed.fieldSchema as Record<string, FieldSpec>)
      : undefined,
    tree
  };
}

/** Repo-shipped macro seeds. Mirrors repoThemesDir() in config.ts:
 * src/lib → ../../macros. */
export function seedMacrosDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'macros');
}

/** Copy seed macros into a site root. Existing files are never
 * overwritten, so an author's customizations survive re-init. */
export function seedSiteMacros(siteRoot: string): string[] {
  const dest = path.join(siteRoot, 'macros');
  fs.mkdirSync(dest, { recursive: true });
  const copied: string[] = [];
  for (const file of fs.readdirSync(seedMacrosDir()).sort()) {
    if (!file.endsWith('.json')) continue;
    const target = path.join(dest, file);
    if (fs.existsSync(target)) continue;
    fs.copyFileSync(path.join(seedMacrosDir(), file), target);
    copied.push(file);
  }
  return copied;
}
function seedNames(): string[] {
  return fs
    .readdirSync(seedMacrosDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

/** Seeds whose site copy is missing or differs from the shipped file. */
export function diffSeedMacros(siteRoot: string): string[] {
  return seedNames().filter((name) => {
    const site = path.join(siteRoot, 'macros', `${name}.json`);
    const seed = path.join(seedMacrosDir(), `${name}.json`);
    return !fs.existsSync(site) || !fs.readFileSync(site).equals(fs.readFileSync(seed));
  });
}

/** Overwrite one site macro from its seed. */
export function updateSiteMacro(siteRoot: string, name: string): void {
  if (!seedNames().includes(name)) throw new Error(`no seed macro named ${name}`);
  const dest = path.join(siteRoot, 'macros');
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(seedMacrosDir(), `${name}.json`), path.join(dest, `${name}.json`));
}

/** Every valid macro under `dir`. A bad file is skipped and logged, so
 * one broken macro never takes down the pages that use the others. */
export function loadMacroLibrary(dir: string, log: MacroLogger = consoleLogger): MacroLib {
  const lib: MacroLib = new Map();
  if (!fs.existsSync(dir)) return lib;
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.json')) continue;
    try {
      const macro = readMacro(file, fs.readFileSync(path.join(dir, file), 'utf8'));
      lib.set(file.slice(0, -'.json'.length), macro);
    } catch (err) {
      log.warn({ file }, `${(err as Error).message}; skipped`);
    }
  }
  return lib;
}

/** Expand one macro instance to a concrete node. Precedence, lowest
 * first: macro defaults, the tree's own inline slots (the shipped
 * content), explicit overrides. Curried macros recurse with fixed
 * slots; explicit overrides always win over fixed slots. */
export function expandMacro(lib: MacroLib, name: string, overrides: Slots): BlockNode {
  const def = lib.get(name);
  if (!def) throw new Error(`macro-library: unknown macro ${name}`);
  const inline = isRecord(def.tree.slots) ? (def.tree.slots as Slots) : {};
  if (def.tree.type === 'macro') {
    const fixed = isRecord(def.tree.slots) ? (def.tree.slots as Slots) : {};
    const inner = expandMacro(lib, def.tree.macro, { ...fixed, ...overrides });
    const base = resolveSlots({ defaults: def.defaults }, {}).slots;
    return { ...inner, slots: { ...base, ...(inner.slots ?? {}), ...overrides } };
  }
  const merged = resolveSlots({ defaults: def.defaults }, overrides).slots;
  return { ...def.tree, slots: { ...merged, ...inline, ...overrides } };
}
