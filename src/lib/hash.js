// Hashing + canonical JSON + cache-key derivation.
// See spec §10 (sidecar/cache key) and §11 (renderDerivative).

import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * Hash a file from disk. Returns sha256 hex.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export function sha256File(filePath) {
  return sha256Stream(fs.createReadStream(filePath));
}

/**
 * Hash a Readable stream end-to-end. Consumes the stream.
 * @param {NodeJS.ReadableStream} stream
 * @returns {Promise<string>}
 */
export function sha256Stream(stream) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Canonical JSON serialization. Required so semantically-identical ops
 * produce identical hashes across nodes and processes (spec §10).
 *
 * Rules:
 * - object keys sorted ascending, recursively
 * - no whitespace
 * - numbers via Number.prototype.toString (already strips trailing zeros)
 * - non-ASCII characters escaped as \uXXXX
 * - undefined object members are omitted (matches JSON.stringify)
 *
 * Throws on bigint, symbol, function — those have no canonical form.
 *
 * @param {*} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return asciiOnly(stringifySorted(value));
}

function stringifySorted(value) {
  if (value === null) return 'null';
  if (value === undefined) {
    throw new TypeError('canonicalJson: undefined has no canonical form');
  }
  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`canonicalJson: non-finite number ${value}`);
    }
    return String(value);
  }
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stringifySorted).join(',') + ']';
  }
  if (t === 'object') {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    const parts = keys.map((k) => JSON.stringify(k) + ':' + stringifySorted(value[k]));
    return '{' + parts.join(',') + '}';
  }
  throw new TypeError(`canonicalJson: unsupported type ${t}`);
}

// JSON.stringify outputs raw non-ASCII; rewrite each code unit at or above
// 0x80 (including unpaired surrogates) as \uXXXX so the output is pure ASCII.
function asciiOnly(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x80) {
      out += s[i];
    } else {
      out += '\\u' + code.toString(16).padStart(4, '0');
    }
  }
  return out;
}

/**
 * Derive the per-derivative cache key. Returns the 12-hex-char `ophash`
 * suffix used in the on-disk filename (spec §11).
 *
 * @param {Object} args
 * @param {string} args.originalId
 * @param {Array}  args.ops
 * @param {Object} args.variant
 * @param {Object} args.output
 * @returns {string} 12-char hex
 */
export function cacheKey({ originalId, ops, variant, output }) {
  const input = canonicalJson({ originalId, ops, variant, output });
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 12);
}
