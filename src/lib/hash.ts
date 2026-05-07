// Hashing + cache-key derivation.
// See spec.md §5 (sidecar/cache key) and implementation.md §5
// (renderDerivative).
//
// canonicalJson lives in lib/canonical-json.ts so the browser bundle
// can import it without dragging in node:crypto / node:fs.

import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Readable } from 'node:stream';

export { type CanonicalValue, canonicalJson } from './canonical-json.ts';

import { type CanonicalValue, canonicalJson } from './canonical-json.ts';

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
 * Derive the per-derivative cache key. Returns the 12-hex-char `ophash`
 * suffix used in the on-disk filename (implementation.md §5).
 */
export function cacheKey({ originalId, ops, variant, output }: CacheKeyArgs): string {
  const input = canonicalJson({ originalId, ops, variant, output });
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 12);
}
