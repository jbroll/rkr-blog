// POST /admin/sidecar/:id/commit — atomic image-edit save. One
// multipart payload carries the new ops AND the client-baked WebP;
// the server validates both, then writes the bake and the sidecar
// back-to-back so no public request ever sees ops+bake disagreement.
//
// Replaces the prior /ops + /bake split. That split required the
// client to POST twice with an X-Rkr-Bake-Ops-Hash guard to detect
// drift between the two requests; the guard kept 409-ing on
// validateOps's normalization rounding (Math.floor on float crop
// coords). Atomic commit makes the hash check unnecessary — the bake
// belongs to the ops that ride with it in the same request.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { FastifyInstance, RouteShorthandOptions } from 'fastify';
import sharp from 'sharp';

import { lookupApplied, pruneApplied, recordApplied } from '../lib/applied-outbox.ts';
import type { Db } from '../lib/db.ts';
import { SHARP_PIXEL_LIMIT } from '../lib/image-constants.ts';
import { validateOps } from '../lib/ops-validation.ts';
import { bakePath, imageInfo } from '../lib/originals.ts';
import { read as sidecarRead, write as sidecarWrite } from '../lib/sidecar.ts';
import { readIdempotencyKey } from './admin-idempotency.ts';
import { evaluateSidecarBase, opsUnchanged, sidecarUpdatedAt } from './sidecar-base.ts';

const BAKE_MAX_BYTES = 25 * 1024 * 1024;
const OPS_MAX_BYTES = 64 * 1024;

export interface SidecarEditRouteOpts {
  siteRoot: string;
  guard: RouteShorthandOptions;
  /** Jobs/idempotency DB. When present, a drained commitImageEdit
   * replayed with the same (x-rkr-device-id, x-rkr-outbox-seq)
   * short-circuits to its original 2xx instead of re-running the
   * non-idempotent write+cache-invalidation. */
  db?: Db;
}

export function registerSidecarEditRoutes(
  fastify: FastifyInstance,
  opts: SidecarEditRouteOpts
): void {
  const { siteRoot, guard, db } = opts;

  fastify.post<{
    Params: { id: string };
  }>(
    '/admin/sidecar/:id/commit',
    { ...guard, bodyLimit: BAKE_MAX_BYTES + OPS_MAX_BYTES },
    async (req, reply) => {
      const { id } = req.params;
      if (!/^[0-9a-f]{64}$/.test(id)) {
        return reply.code(400).send({ error: 'invalid id' });
      }

      // Server-side outbox idempotency (Task 8). commitImageEdit is
      // non-idempotent (writes the bake, rewrites the sidecar,
      // unlinks stale derivatives); a lost-ACK replay must return the
      // original 2xx, not re-run the work.
      const idem = readIdempotencyKey(req.headers);
      if (idem && db) {
        const prior = lookupApplied(db, idem.deviceId, idem.seq);
        if (prior) {
          return reply.code(prior.status).type('application/json').send(prior.body);
        }
      }
      const sidecar = await sidecarRead(siteRoot, id);
      if (!sidecar) return reply.code(404).send({ error: 'no sidecar' });

      // Collect multipart parts: a single `ops` text part with the
      // ops + redoStack JSON, and an optional `bake` file part (must
      // be present when ops is non-empty).
      let opsText: string | null = null;
      let bakeBuf: Buffer | null = null;
      try {
        for await (const part of req.parts()) {
          if (part.type === 'field' && part.fieldname === 'ops') {
            const v = part.value;
            if (typeof v !== 'string') {
              return reply.code(400).send({ error: '`ops` field must be a string' });
            }
            if (v.length > OPS_MAX_BYTES) {
              return reply.code(413).send({ error: '`ops` field too large' });
            }
            opsText = v;
          } else if (part.type === 'file' && part.fieldname === 'bake') {
            bakeBuf = await part.toBuffer();
            /* c8 ignore next 3 -- truncated when bodyLimit exceeded */
            if (part.file.truncated) {
              return reply.code(413).send({ error: 'bake too large' });
            }
          }
        }
      } catch (err) {
        req.log.warn({ err, id }, 'multipart parse failed');
        return reply.code(400).send({ error: 'malformed multipart body' });
      }

      if (opsText === null) {
        return reply.code(400).send({ error: '`ops` field required' });
      }
      let parsed: { ops?: unknown; redoStack?: unknown };
      try {
        parsed = JSON.parse(opsText);
      } catch {
        return reply.code(400).send({ error: '`ops` field must be valid JSON' });
      }

      // Crop-bounds check needs the source's actual pixel dims, which
      // come from the file on disk. imageInfo returns null when the
      // original is missing — validateOps handles that as the "no
      // recorded dimensions" branch (ops=[] accepted, non-empty
      // refused).
      const info = await imageInfo(siteRoot, id);
      const dims = info ? { width: info.width ?? 0, height: info.height ?? 0 } : {};
      const opsV = validateOps(parsed.ops, dims);
      if (!opsV.ok) return reply.code(400).send({ error: opsV.error });
      const rsV = validateOps(parsed.redoStack ?? [], dims);
      if (!rsV.ok) return reply.code(400).send({ error: `redoStack: ${rsV.error}` });

      // Idempotency / optimistic-concurrency, mirroring savePost. The
      // applied_outbox table short-circuit ran first (above). Now,
      // BEFORE any write:
      //
      //   (1) Cheap pure-replay no-op. If the on-disk ops + redoStack
      //       already equal what's being committed, this drained entry
      //       was already applied (lost-ACK replay after the table row
      //       was pruned / db absent). Return the normal 2xx without
      //       re-running the non-idempotent write — and without
      //       requiring the bake (a pure replay may re-POST without
      //       it, exactly like the table layer). It must NOT swallow
      //       the "bake forbidden when ops is empty" contract though:
      //       a genuine pure replay of a clear-edits save never
      //       carries a bake, so a bake here is a malformed request
      //       regardless of disk state — fall through to the 400.
      //
      //   (2) Optimistic-concurrency guard. If the client supplied an
      //       edit-start baseline (x-rkr-sidecar-base, the sidecar
      //       updated_at it saw when editing began) and the on-disk
      //       sidecar has advanced PAST it, a newer same-image edit
      //       landed while this entry was queued offline. With (1)
      //       already ruling out a pure replay, applying now would
      //       silently revert that newer edit — reject with 409
      //       instead. Absent header (legacy queued entry) → no 409,
      //       backward compatible; the table + no-op still cover pure
      //       replays.
      const malformedEmptyWithBake = opsV.ops.length === 0 && bakeBuf !== null;
      if (!malformedEmptyWithBake && opsUnchanged(sidecar, opsV.ops, rsV.ops)) {
        const body = {
          ops: sidecar.ops,
          redoStack: sidecar.redoStack ?? [],
          updatedAt: sidecarUpdatedAt(siteRoot, id)
        };
        if (idem && db) {
          recordApplied(db, idem.deviceId, idem.seq, 200, JSON.stringify(body));
          pruneApplied(db);
        }
        return body;
      }
      const baseRaw = req.headers['x-rkr-sidecar-base'];
      if (typeof baseRaw === 'string' && Number.isNaN(Date.parse(baseRaw))) {
        return reply.code(400).send({ error: 'x-rkr-sidecar-base must be an ISO-8601 timestamp' });
      }
      const base = evaluateSidecarBase(baseRaw, siteRoot, id);
      if (base.verdict === 'superseded') {
        return reply.code(409).send({
          error: 'sidecar-superseded',
          id,
          serverUpdatedAt: base.serverUpdatedAt,
          clientBase: baseRaw
        });
      }

      // ops=[] is the "clear all edits" save: no bake to upload, just
      // unlink any existing one. Non-empty ops require the matching
      // bake — otherwise render would fall back to applying ops live
      // via sharp, which can't do perspective and is slower for any
      // case the client already computed pixels for.
      if (opsV.ops.length > 0 && bakeBuf === null) {
        return reply.code(400).send({ error: 'bake required for non-empty ops' });
      }
      if (opsV.ops.length === 0 && bakeBuf !== null) {
        return reply.code(400).send({ error: 'bake forbidden when ops is empty' });
      }

      if (bakeBuf !== null) {
        if (bakeBuf.length === 0) {
          return reply.code(400).send({ error: 'empty bake' });
        }
        // Accept WebP (RIFF/WEBP magic) or JPEG (FF D8 FF magic).
        // iOS Safari/Chrome can't produce WebP from canvas and fall back
        // to JPEG; we accept both and re-encode JPEG→WebP before storing
        // so all bakes on disk are always WebP.
        const isWebP =
          bakeBuf.length >= 12 &&
          bakeBuf.subarray(0, 4).toString('ascii') === 'RIFF' &&
          bakeBuf.subarray(8, 12).toString('ascii') === 'WEBP';
        const isJpeg = bakeBuf.length >= 2 && bakeBuf[0] === 0xff && bakeBuf[1] === 0xd8;
        if (!isWebP && !isJpeg) {
          return reply.code(400).send({ error: 'bake must be WebP or JPEG' });
        }
        try {
          const meta = await sharp(bakeBuf, {
            failOn: 'error',
            limitInputPixels: SHARP_PIXEL_LIMIT
          }).metadata();
          if (meta.format !== 'webp' && meta.format !== 'jpeg') {
            return reply.code(400).send({ error: 'bake did not decode as WebP or JPEG' });
          }
          const w = meta.width ?? 0;
          const h = meta.height ?? 0;
          /* c8 ignore next 5 -- requires a valid image that exceeds
             SHARP_PIXEL_LIMIT; the BAKE_MAX_BYTES cap makes this
             infeasible from real clients */
          if (w * h > SHARP_PIXEL_LIMIT) {
            return reply
              .code(400)
              .send({ error: `bake exceeds pixel limit (${w}×${h} > ${SHARP_PIXEL_LIMIT})` });
          }
          // Re-encode JPEG → WebP so all stored bakes are WebP.
          /* c8 ignore next 3 -- JPEG bake path; exercised by iOS clients */
          if (meta.format === 'jpeg') {
            bakeBuf = await sharp(bakeBuf).webp({ quality: 92 }).toBuffer();
          }
        } catch (err) {
          req.log.warn({ err, id }, 'bake decode failed');
          return reply.code(400).send({ error: 'bake is not a decodable WebP or JPEG' });
        }
      }

      // Snapshot stale derivatives BEFORE any write so we don't race
      // a render-in-flight that's about to rename its tmp into the
      // current ops's cacheKey slot.
      const cacheImgDir = path.join(siteRoot, 'cache', 'img');
      let staleNames: string[] = [];
      try {
        staleNames = (await fs.promises.readdir(cacheImgDir)).filter((n) => n.startsWith(`${id}.`));
      } catch (err) {
        /* c8 ignore next 3 -- ENOENT is fine; directory may not exist yet */
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }

      // Write ordering: sidecar committed before bake renamed into place.
      // A crash after sidecar rename but before bake rename leaves a stale
      // bake tmp (GC sweeps *.tmp); the renderer falls through to recompute
      // from ops — correct. The reverse ordering (bake first) would leave
      // new pixels under old ops with no fallback.
      const finalBakePath = bakePath(siteRoot, id);
      let bakeTmp: string | null = null;
      if (bakeBuf !== null) {
        await fs.promises.mkdir(path.dirname(finalBakePath), { recursive: true });
        bakeTmp = `${finalBakePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        try {
          await fs.promises.writeFile(bakeTmp, bakeBuf);
        } catch (err) {
          /* c8 ignore start -- writeFile failure under normal volumes */
          await fs.promises.unlink(bakeTmp).catch(() => {});
          req.log.error({ err, id }, 'bake write failed');
          return reply.code(500).send({ error: 'bake write failed' });
          /* c8 ignore stop */
        }
      } else {
        await fs.promises.unlink(finalBakePath).catch(() => {});
      }

      sidecar.ops = opsV.ops;
      if (rsV.ops.length === 0) {
        delete sidecar.redoStack;
      } else {
        sidecar.redoStack = rsV.ops;
      }
      try {
        await sidecarWrite(siteRoot, id, sidecar);
      } catch (err) {
        /* c8 ignore start -- IO failure on rename is hard to fault-inject */
        if (bakeTmp) await fs.promises.unlink(bakeTmp).catch(() => {});
        req.log.error({ err, id }, 'sidecar write failed');
        return reply.code(500).send({ error: 'sidecar write failed' });
        /* c8 ignore stop */
      }

      if (bakeTmp !== null) {
        try {
          await fs.promises.rename(bakeTmp, finalBakePath);
        } catch (err) {
          /* c8 ignore start -- rename failure; renderer will recompute from ops */
          await fs.promises.unlink(bakeTmp).catch(() => {});
          req.log.warn({ err, id }, 'bake rename failed — renderer will recompute');
          /* c8 ignore stop */
        }
      }

      for (const name of staleNames) {
        await fs.promises.unlink(path.join(cacheImgDir, name)).catch(() => {});
      }

      // Echo the sidecar's new updated_at so the client can re-anchor
      // its edit-start baseline for the next commit's guard (mirrors
      // savePost echoing updatedAt → meta.lastSyncedAt).
      const body = {
        ops: sidecar.ops,
        redoStack: sidecar.redoStack ?? [],
        updatedAt: sidecarUpdatedAt(siteRoot, id)
      };
      if (idem && db) {
        recordApplied(db, idem.deviceId, idem.seq, 200, JSON.stringify(body));
        pruneApplied(db);
      }
      return body;
    }
  );
}
