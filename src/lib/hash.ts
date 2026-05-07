// Hashing + canonical JSON + cache-key derivation.
// See spec.md §5 (sidecar/cache key) and implementation.md §5
// (renderDerivative).

import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Readable } from 'node:stream';

/** Values that have a canonical-JSON representation. */
export type CanonicalValue =
  | null
  | string
  | number
  | boolean
  | CanonicalValue[]
  | { [k: string]: CanonicalValue | undefined };

export interface CacheKeyArgs {
  originalId: string;
  ops: CanonicalValue[];
  variant: Record<string, CanonicalValue | undefined>;
  output: Record<string, CanonicalValue | undefined>;
}

/** Hash a file from disk. Returns sha256 hex. */
export function sha256File(filePath: string): Promise<string> {
  return sha256Stream(fs.createReadStream(filePath));
}

/** Hash a Readable stream end-to-end. Consumes the stream. */
export function sha256Stream(stream: Readable): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    stream.on('data', (chunk: Buffer | string) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Canonical JSON serialization. Required so semantically-identical ops
 * produce identical hashes across nodes and processes (spec.md §5).
 *
 * Rules:
 * - object keys sorted ascending, recursively
 * - no whitespace
 * - numbers via Number.prototype.toString (already strips trailing zeros)
 * - non-ASCII characters escaped as \uXXXX
 * - undefined object members are omitted (matches JSON.stringify)
 *
 * Throws on bigint, symbol, function — those have no canonical form.
 */
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

/**
 * Derive the per-derivative cache key. Returns the 12-hex-char `ophash`
 * suffix used in the on-disk filename (implementation.md §5).
 */
export function cacheKey({ originalId, ops, variant, output }: CacheKeyArgs): string {
  const input = canonicalJson({ originalId, ops, variant, output });
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 12);
}
