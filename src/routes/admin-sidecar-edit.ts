// POST /admin/sidecar/:id/ops + POST /admin/sidecar/:id/bake — the
// editor's image-edit pipeline. /ops persists a new ops array (and
// optional redoStack); /bake receives the WebP the client canvas
// produced after applying those ops. Both invalidate stale cache
// entries so subsequent /img requests re-render.
//
// Lives separately from src/routes/admin.ts to keep that file under
// the 500-line cap.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { FastifyInstance, RouteShorthandOptions } from 'fastify';
import sharp from 'sharp';

import { canonicalJson } from '../lib/canonical-json.ts';
import { SHARP_PIXEL_LIMIT } from '../lib/image-constants.ts';
import { bakePath } from '../lib/originals.ts';
import { read as sidecarRead, write as sidecarWrite } from '../lib/sidecar.ts';
import type { SidecarOp } from '../lib/sidecar-types.ts';
import { validateOps } from './admin-ops-validation.ts';

const BAKE_MAX_BYTES = 25 * 1024 * 1024;

export interface SidecarEditRouteOpts {
  siteRoot: string;
  guard: RouteShorthandOptions;
}

export function registerSidecarEditRoutes(
  fastify: FastifyInstance,
  opts: SidecarEditRouteOpts
): void {
  const { siteRoot, guard } = opts;

  // Raw-body parser for /admin/sidecar/:id/bake. The editor POSTs a
  // WebP blob; without an explicit parser fastify rejects unknown
  // content types. Capped at BAKE_MAX_BYTES (matches the route limit).
  fastify.addContentTypeParser(
    'image/webp',
    { parseAs: 'buffer', bodyLimit: BAKE_MAX_BYTES },
    (_req, body, done) => done(null, body)
  );

  // Replace a sidecar's ops array. Used by the crop / rotate / flip /
  // resample buttons in the image attribute panel.
  // Edit ops live on the SIDECAR, not per-instance: changing a sidecar's
  // ops affects every post that references this image. That's the
  // existing render-pipeline design (sidecar.ops is the source of truth).
  fastify.post<{
    Params: { id: string };
    Body: { ops?: unknown; redoStack?: unknown };
  }>('/admin/sidecar/:id/ops', { ...guard }, async (req, reply) => {
    const { id } = req.params;
    if (!/^[0-9a-f]{64}$/.test(id)) {
      return reply.code(400).send({ error: 'invalid id' });
    }
    const sidecar = await sidecarRead(siteRoot, id);
    if (!sidecar) return reply.code(404).send({ error: 'no sidecar' });

    const validation = validateOps(req.body?.ops, sidecar.metadata);
    if (!validation.ok) return reply.code(400).send({ error: validation.error });

    // redoStack uses the same op-shape validator. The bounds check
    // against metadata is shared — popping an undone crop later
    // shouldn't suddenly produce out-of-bounds coords.
    let redoStackOut: SidecarOp[] = [];
    if (req.body?.redoStack !== undefined) {
      const rsValidation = validateOps(req.body.redoStack, sidecar.metadata);
      if (!rsValidation.ok) {
        return reply.code(400).send({ error: `redoStack: ${rsValidation.error}` });
      }
      redoStackOut = rsValidation.ops;
    }

    // Snapshot existing derivative filenames BEFORE writing the new
    // sidecar. After the write, every derivative still on disk is
    // bound to the OLD ops (different cacheKey from anything we'd
    // generate now). Unlink them so a previously-shared
    //   /img/<id>.<oldHash>.<fmt>
    // URL stops serving the stale uncropped image. Snapshotting
    // first avoids racing a render-in-flight that's about to rename
    // its tmp into final position with the new ops.
    const cacheImgDir = path.join(siteRoot, 'cache', 'img');
    const stalePrefix = `${id}.`;
    let staleNames: string[] = [];
    try {
      staleNames = (await fs.promises.readdir(cacheImgDir)).filter((n) =>
        n.startsWith(stalePrefix)
      );
    } catch (err) {
      /* c8 ignore next 3 -- ENOENT is fine; directory may not exist yet */
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    sidecar.ops = validation.ops;
    // Persist redoStack only when the client supplied one. Omitting
    // body.redoStack preserves whatever was on disk (e.g. a different
    // editor surface POSTing only ops).
    if (req.body?.redoStack !== undefined) {
      if (redoStackOut.length === 0) {
        delete sidecar.redoStack;
      } else {
        sidecar.redoStack = redoStackOut;
      }
    }
    try {
      await sidecarWrite(siteRoot, id, sidecar);
    } catch (err) {
      /* c8 ignore start -- IO failure on rename is hard to fault-inject;
         covered by integration if a future filesystem fault appears */
      req.log.error({ err, id }, 'sidecar write failed');
      return reply.code(500).send({ error: 'sidecar write failed' });
      /* c8 ignore stop */
    }

    // Best-effort cleanup; failures don't block the response.
    for (const name of staleNames) {
      await fs.promises.unlink(path.join(cacheImgDir, name)).catch(() => {});
    }
    // Also drop the client-baked post-ops image (if any). The bake
    // corresponds to the *previous* ops; the editor will re-upload
    // a fresh bake right after this POST returns. Until then, the
    // render pipeline falls back to the original.
    await fs.promises.unlink(bakePath(siteRoot, id)).catch(() => {});

    return { ops: sidecar.ops, redoStack: sidecar.redoStack ?? [] };
  });

  // Receive the editor's client-baked post-ops image for this id. The
  // canvas pipeline is now the authority on pixel results — this endpoint
  // just persists what the browser produced. The render pipeline reads
  // the bake instead of re-applying ops via sharp, taking ops out of
  // the per-request hot path.
  //
  // Body is the raw WebP bytes (image/webp content type). 25 MB cap
  // is well above realistic bakes (a 50 MP camera image at q=0.95 is
  // ~5-10 MB) but tight enough that a runaway / misused client can't
  // wedge a multi-GB upload through.
  fastify.post<{
    Params: { id: string };
  }>('/admin/sidecar/:id/bake', { ...guard, bodyLimit: BAKE_MAX_BYTES }, async (req, reply) => {
    const { id } = req.params;
    if (!/^[0-9a-f]{64}$/.test(id)) {
      return reply.code(400).send({ error: 'invalid id' });
    }
    const ct = (req.headers['content-type'] ?? '').toLowerCase();
    if (!ct.startsWith('image/webp')) {
      return reply.code(415).send({ error: 'content-type must be image/webp' });
    }
    const sidecar = await sidecarRead(siteRoot, id);
    if (!sidecar) return reply.code(404).send({ error: 'no sidecar' });

    // Bake-ops-hash guard (spec.md §7). Two clients racing the same id
    // (offline reconnect, two-tab session) can land a bake matching a
    // stale opset; the public site would serve the wrong pixels until
    // the next save. Rejecting the mismatch + asking the client to
    // re-bake against current ops is the only safe answer.
    const headerHash = req.headers['x-rkr-bake-ops-hash'];
    if (typeof headerHash !== 'string' || headerHash.length === 0) {
      return reply
        .code(400)
        .send({ error: 'X-Rkr-Bake-Ops-Hash header required (sha256 of canonical(ops))' });
    }
    const expectedHash = crypto
      .createHash('sha256')
      .update(canonicalJson(sidecar.ops as readonly SidecarOp[]), 'utf8')
      .digest('hex');
    if (headerHash !== expectedHash) {
      req.log.warn({ id, headerHash, expectedHash }, 'bake ops-hash mismatch');
      return reply.code(409).send({
        error: 'bake-ops-mismatch',
        expectedHash,
        message: 'bake was computed against stale ops; re-bake against current ops + retry'
      });
    }

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: 'empty body' });
    }
    // Magic-byte check: WebP files start with "RIFF????WEBP". Cheap
    // sanity check that the client posted what it claimed.
    if (
      body.length < 12 ||
      body.slice(0, 4).toString('ascii') !== 'RIFF' ||
      body.slice(8, 12).toString('ascii') !== 'WEBP'
    ) {
      return reply.code(400).send({ error: 'body is not a WebP file' });
    }
    // Full decode-side validation. The magic-byte check above is cheap
    // but a malformed WebP (truncated chunks, oversized declared dims)
    // would only fail at first render time. Run sharp.metadata() now
    // so corrupt or decompression-bomb uploads are rejected at the
    // boundary rather than landing on disk and 500-ing every public
    // image request that hits this id.
    try {
      const meta = await sharp(body, {
        failOn: 'error',
        limitInputPixels: SHARP_PIXEL_LIMIT
      }).metadata();
      if (meta.format !== 'webp') {
        return reply.code(400).send({ error: 'body did not decode as WebP' });
      }
      const w = meta.width ?? 0;
      const h = meta.height ?? 0;
      /* c8 ignore next 5 -- requires constructing a valid WebP that
         exceeds SHARP_PIXEL_LIMIT — the body-cap above (25 MB) makes
         this infeasible from real clients */
      if (w * h > SHARP_PIXEL_LIMIT) {
        return reply
          .code(400)
          .send({ error: `bake exceeds pixel limit (${w}×${h} > ${SHARP_PIXEL_LIMIT})` });
      }
    } catch (err) {
      req.log.warn({ err, id }, 'bake decode failed');
      return reply.code(400).send({ error: 'body is not a decodable WebP' });
    }

    const finalPath = bakePath(siteRoot, id);
    await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
    const tmp = `${finalPath}.${randomSuffix()}.tmp`;
    try {
      await fs.promises.writeFile(tmp, body);
      await fs.promises.rename(tmp, finalPath);
    } catch (err) {
      /* c8 ignore start -- writeFile/rename failure under normal volumes
         is hard to fault-inject; covered by integration if a future
         filesystem fault appears */
      await fs.promises.unlink(tmp).catch(() => {});
      req.log.error({ err, id }, 'bake write failed');
      return reply.code(500).send({ error: 'bake write failed' });
      /* c8 ignore stop */
    }

    // Drop any stale derivatives keyed off the prior bake / prior
    // ops. /ops also does this when ops change, but /bake catches the
    // case where ops didn't change (e.g. user re-baked at higher
    // quality) so previously-cached derivatives still match the
    // current cacheKey.
    const cacheImgDir = path.join(siteRoot, 'cache', 'img');
    try {
      const stale = (await fs.promises.readdir(cacheImgDir)).filter((n) => n.startsWith(`${id}.`));
      for (const name of stale) {
        await fs.promises.unlink(path.join(cacheImgDir, name)).catch(() => {});
      }
    } catch (err) {
      /* c8 ignore next -- ENOENT is fine; directory may not exist yet */
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    return { bytes: body.length };
  });
}

function randomSuffix(): string {
  return crypto.randomBytes(6).toString('hex');
}
