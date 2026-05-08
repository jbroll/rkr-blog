// Sidecar JSON read/write/validate. One file per logical image at
// $SITE_ROOT/sidecars/<id>.json (see spec.md §5 sidecar schema).
// Type declarations live in ./sidecar-types.ts so the browser bundle
// can import them without pulling in node:fs / node:crypto.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Sidecar } from './sidecar-types.ts';

export const CURRENT_VERSION = 1;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export type ValidateResult = { ok: true } | { ok: false; error: string };

/** Read a sidecar by original id. Returns null if it doesn't exist. */
export async function read(siteRoot: string, id: string): Promise<Sidecar | null> {
  const p = sidecarPath(siteRoot, id);
  try {
    const raw = await fs.promises.readFile(p, 'utf8');
    return JSON.parse(raw) as Sidecar;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Atomically write a sidecar. Validates first. */
export async function write(siteRoot: string, id: string, data: Sidecar): Promise<void> {
  const v = validate(data);
  if (!v.ok) throw new Error(`sidecar.write: invalid data: ${v.error}`);
  if (data.original !== id) {
    throw new Error(`sidecar.write: id mismatch (path=${id}, data.original=${data.original})`);
  }

  const dir = path.join(siteRoot, 'sidecars');
  await fs.promises.mkdir(dir, { recursive: true });

  const final = sidecarPath(siteRoot, id);
  const tmp = `${final}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.promises.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fs.promises.rename(tmp, final);
}

/**
 * Validate sidecar shape. Conservative — checks required keys and types,
 * without enforcing every constraint of the schema. Unknown keys are allowed
 * so callers can add fields without invalidating existing data.
 */
export function validate(data: unknown): ValidateResult {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'sidecar must be an object' };
  }
  const d = data as Record<string, unknown>;

  if (d.version !== CURRENT_VERSION) {
    return { ok: false, error: `unsupported version ${String(d.version)}` };
  }

  if (typeof d.original !== 'string' || !SHA256_HEX.test(d.original)) {
    return { ok: false, error: 'original must be a 64-char lowercase sha256 hex string' };
  }

  if (d.source === null || typeof d.source !== 'object' || Array.isArray(d.source)) {
    return { ok: false, error: 'source must be an object' };
  }
  const source = d.source as Record<string, unknown>;
  if (typeof source.kind !== 'string') {
    return { ok: false, error: 'source.kind must be a string' };
  }

  if (d.metadata === null || typeof d.metadata !== 'object' || Array.isArray(d.metadata)) {
    return { ok: false, error: 'metadata must be an object' };
  }

  for (const k of ['ops', 'outputs', 'variants'] as const) {
    if (!Array.isArray(d[k])) {
      return { ok: false, error: `${k} must be an array` };
    }
  }
  // redoStack is optional; if present, must be an array.
  if (d.redoStack !== undefined && !Array.isArray(d.redoStack)) {
    return { ok: false, error: 'redoStack must be an array' };
  }

  return { ok: true };
}

export function sidecarPath(siteRoot: string, id: string): string {
  return path.join(siteRoot, 'sidecars', `${id}.json`);
}
