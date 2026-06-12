// Canonical JSON serialization, used in two places:
//   - server-side cache-key derivation (lib/hash.ts → cacheKey)
//   - browser-side dirty-state comparison (admin/main.ts → isDirty)
//
// Lives in its own module so the browser bundle doesn't pull in
// node:crypto / node:fs from lib/hash.ts.
//
// Rules:
// - object keys sorted ascending, recursively
// - no whitespace
// - numbers via Number.prototype.toString (already strips trailing zeros)
// - non-ASCII characters escaped as \uXXXX
// - undefined object members are omitted (matches JSON.stringify)
//
// Throws on bigint, symbol, function — those have no canonical form.

/** Values that have a canonical-JSON representation. */
export type CanonicalValue =
  | null
  | string
  | number
  | boolean
  | CanonicalValue[]
  | { [k: string]: CanonicalValue | undefined };

export function canonicalJson(value: unknown): string {
  return asciiOnly(stringifySorted(value));
}

function stringifySorted(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) {
    throw new TypeError('canonicalJson: undefined has no canonical form');
  }
  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new TypeError(`canonicalJson: non-finite number ${value as number}`);
    }
    return String(value);
  }
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stringifySorted).join(',')}]`;
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${stringifySorted(obj[k])}`);
    return `{${parts.join(',')}}`;
  }
  throw new TypeError(`canonicalJson: unsupported type ${t}`);
}

// JSON.stringify outputs raw non-ASCII; rewrite each code unit at or above
// 0x80 (including unpaired surrogates) as \uXXXX so the output is pure ASCII.
function asciiOnly(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x80) {
      out += s[i];
    } else {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    }
  }
  return out;
}
