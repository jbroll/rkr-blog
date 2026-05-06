// Sidecar JSON read/write/validate. One file per logical image at
// $SITE_ROOT/sidecars/<id>.json (spec §10).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CURRENT_VERSION = 1;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Read a sidecar by original id. Returns null if it doesn't exist.
 *
 * @param {string} siteRoot
 * @param {string} id - sha256 hex
 * @returns {Promise<Object|null>}
 */
export async function read(siteRoot, id) {
  const p = sidecarPath(siteRoot, id);
  try {
    const raw = await fs.promises.readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Atomically write a sidecar. Validates first.
 *
 * @param {string} siteRoot
 * @param {string} id
 * @param {Object} data
 */
export async function write(siteRoot, id, data) {
  const v = validate(data);
  if (!v.ok) throw new Error(`sidecar.write: invalid data: ${v.error}`);
  if (data.original !== id) {
    throw new Error(`sidecar.write: id mismatch (path=${id}, data.original=${data.original})`);
  }

  const dir = path.join(siteRoot, 'sidecars');
  await fs.promises.mkdir(dir, { recursive: true });

  const final = sidecarPath(siteRoot, id);
  const tmp = `${final}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fs.promises.rename(tmp, final);
}

/**
 * Validate sidecar shape. Conservative — checks required keys and types,
 * without enforcing every constraint of the schema. Unknown keys are allowed
 * so callers can add fields without invalidating existing data.
 *
 * @param {*} data
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validate(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'sidecar must be an object' };
  }

  if (data.version !== CURRENT_VERSION) {
    return { ok: false, error: `unsupported version ${data.version}` };
  }

  if (typeof data.original !== 'string' || !SHA256_HEX.test(data.original)) {
    return { ok: false, error: 'original must be a 64-char lowercase sha256 hex string' };
  }

  if (data.source === null || typeof data.source !== 'object' || Array.isArray(data.source)) {
    return { ok: false, error: 'source must be an object' };
  }
  if (typeof data.source.kind !== 'string') {
    return { ok: false, error: 'source.kind must be a string' };
  }

  if (data.metadata === null || typeof data.metadata !== 'object' || Array.isArray(data.metadata)) {
    return { ok: false, error: 'metadata must be an object' };
  }

  for (const k of ['ops', 'outputs', 'variants']) {
    if (!Array.isArray(data[k])) {
      return { ok: false, error: `${k} must be an array` };
    }
  }

  return { ok: true };
}

export function sidecarPath(siteRoot, id) {
  return path.join(siteRoot, 'sidecars', `${id}.json`);
}
