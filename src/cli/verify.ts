// `site-admin verify` — rehash every original on disk and flag any sidecar
// whose `original` does not match the recomputed sha256 of its bytes.
//
// Bit-rot detector. Read-only: no mutation of disk state.

import fs from 'node:fs';

import { paths } from '../lib/config.ts';
import { sha256File } from '../lib/hash.ts';
import { FORMAT_TO_EXT } from '../lib/image-constants.ts';
import { originalPath } from '../lib/originals.ts';
import { listSidecars } from '../lib/posts.ts';

export interface VerifyMismatch {
  id: string;
  reason: 'missing-original' | 'unsupported-format' | 'hash-mismatch';
  detail?: string;
}

export interface VerifyResult {
  checked: number;
  mismatches: VerifyMismatch[];
}

export default async function verifyCmd(_argv: string[]): Promise<void> {
  const result = await runVerify(paths().root);
  if (result.mismatches.length === 0) {
    console.log(`verify: ${result.checked} originals OK`);
    return;
  }
  console.log(`verify: ${result.checked} checked, ${result.mismatches.length} mismatch(es):`);
  for (const m of result.mismatches) {
    /* c8 ignore next -- all current mismatch shapes supply detail; the empty-string fallback is defensive against future shapes */
    const detail = m.detail ? ` — ${m.detail}` : '';
    console.log(`  ${m.id}  ${m.reason}${detail}`);
  }
  process.exitCode = 1;
}

export async function runVerify(siteRoot: string): Promise<VerifyResult> {
  const sidecars = await listSidecars(siteRoot);
  const mismatches: VerifyMismatch[] = [];
  let checked = 0;

  for (const s of sidecars) {
    const fmt = s.metadata.format;
    const ext = fmt ? FORMAT_TO_EXT[fmt] : undefined;
    if (!ext) {
      mismatches.push({
        id: s.original,
        reason: 'unsupported-format',
        detail: `metadata.format=${String(fmt)}`
      });
      continue;
    }

    const filepath = originalPath(siteRoot, s.original, ext);
    if (!fs.existsSync(filepath)) {
      mismatches.push({
        id: s.original,
        reason: 'missing-original',
        detail: filepath
      });
      continue;
    }

    const actual = await sha256File(filepath);
    checked++;
    if (actual !== s.original) {
      mismatches.push({
        id: s.original,
        reason: 'hash-mismatch',
        detail: `actual=${actual}`
      });
    }
  }

  return { checked, mismatches };
}
