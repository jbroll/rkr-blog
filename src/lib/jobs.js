// Job queue. The `jobs` SQLite table is the queue (no Redis, no BullMQ
// — see spec §3, §11). One worker codepath drives the queue from two
// contexts: inside Fastify (in-process worker, woken by EventEmitter
// on enqueue) and inside `site-admin render` (drains and exits).
//
// Concurrency safety relies on `UPDATE … WHERE state='queued' RETURNING id`
// — only one worker's UPDATE will see the row in queued state. Other
// workers' UPDATEs will return zero rows.

import { EventEmitter } from 'node:events';
import os from 'node:os';

import { renderDerivative } from './render.js';

// Process-local wakeup signal. workQueue() listens for 'enqueued'.
// One emitter per process is sufficient: SQLite is the source of truth;
// EventEmitter is just a latency optimization over polling.
export const events = new EventEmitter();

const POLL_INTERVAL_MS = 250;

/**
 * Enqueue a job. The schema enforces `cache_key UNIQUE`, so when a row with
 * the same cacheKey already exists:
 *   - state queued or running → return the existing id (duplicate).
 *   - state done or failed    → reset that row back to queued and return its id.
 *
 * cacheKey is the 12-char ophash for render jobs.
 *
 * @param {Object} db
 * @param {Object} args
 * @param {string} args.kind         - 'render'
 * @param {Object} args.payload
 * @param {string} [args.cacheKey]
 * @returns {{ id: number, duplicate: boolean }}
 */
export function enqueue(db, { kind, payload, cacheKey }) {
  const now = new Date().toISOString();

  if (cacheKey) {
    const existing = db.prepare('SELECT id, state FROM jobs WHERE cache_key = ?').get(cacheKey);
    if (existing) {
      if (existing.state === 'queued' || existing.state === 'running') {
        return { id: existing.id, duplicate: true };
      }
      // done or failed → reset to queued so the worker picks it up again.
      db.prepare(
        `UPDATE jobs SET state='queued', payload=?, error=NULL, updated_at=?
         WHERE id=?`
      ).run(JSON.stringify(payload), now, existing.id);
      events.emit('enqueued', { id: existing.id, kind });
      return { id: existing.id, duplicate: false };
    }
  }

  const r = db
    .prepare(
      `INSERT INTO jobs (kind, payload, state, attempts, created_at, updated_at, cache_key)
       VALUES (?, ?, 'queued', 0, ?, ?, ?)`
    )
    .run(kind, JSON.stringify(payload), now, now, cacheKey ?? null);

  events.emit('enqueued', { id: r.lastInsertRowid, kind });
  return { id: r.lastInsertRowid, duplicate: false };
}

/**
 * Atomically claim one queued job. Returns null if none available.
 *
 * Two-step claim: SELECT a candidate, then UPDATE WHERE state='queued'
 * RETURNING id. Only the worker whose UPDATE sees the row in queued state
 * gets it; others see RETURNING with zero rows.
 *
 * @param {Object} db
 * @returns {{ id: number, kind: string, payload: Object } | null}
 */
export function claim(db) {
  const candidate = db
    .prepare(
      "SELECT id, kind, payload FROM jobs WHERE state='queued' ORDER BY created_at, id LIMIT 1"
    )
    .get();
  if (!candidate) return null;

  const now = new Date().toISOString();
  const claimed = db
    .prepare(
      `UPDATE jobs SET state='running', updated_at=?, attempts=attempts+1
       WHERE id=? AND state='queued'
       RETURNING id`
    )
    .get(now, candidate.id);
  if (!claimed) return null;

  return {
    id: candidate.id,
    kind: candidate.kind,
    payload: JSON.parse(candidate.payload)
  };
}

/**
 * Mark a job done (no error) or failed (with error message).
 */
export function complete(db, id, { error } = {}) {
  const now = new Date().toISOString();
  if (error) {
    db.prepare("UPDATE jobs SET state='failed', error=?, updated_at=? WHERE id=?").run(
      String(error).slice(0, 4000),
      now,
      id
    );
  } else {
    db.prepare("UPDATE jobs SET state='done', updated_at=? WHERE id=?").run(now, id);
  }
}

/**
 * Default handler for `kind: 'render'` jobs. Calls renderDerivative.
 */
export async function renderHandler(payload, ctx) {
  const { originalId, ops, variant, output } = payload;
  await renderDerivative({
    originalId,
    ops,
    variant,
    output,
    siteRoot: ctx.siteRoot
  });
}

const DEFAULT_HANDLERS = { render: renderHandler };

/**
 * Run the worker loop. Returns a controller with stop() and drained()
 * helpers. When `drainAndExit: true`, the loop exits as soon as the
 * queue is empty (used by `site-admin render`).
 *
 * @param {Object} args
 * @param {Object} args.db
 * @param {Object} args.ctx                - passed to handlers
 * @param {Object} [args.handlers]         - { kind: async fn }
 * @param {number} [args.concurrency]
 * @param {boolean} [args.drainAndExit]
 * @returns {{ stop: () => Promise<void>, drained: () => Promise<void> }}
 */
export function workQueue({
  db,
  ctx,
  handlers = DEFAULT_HANDLERS,
  concurrency = Math.max(1, os.cpus().length),
  drainAndExit = false
}) {
  let stopped = false;
  let inflight = 0;
  let wakeResolve = null;
  const drainListeners = [];

  function wake() {
    if (wakeResolve) {
      const r = wakeResolve;
      wakeResolve = null;
      r();
    }
  }

  function notifyDrain() {
    if (inflight === 0) {
      while (drainListeners.length) drainListeners.shift()();
    }
  }

  events.on('enqueued', wake);

  async function runOne(job) {
    inflight++;
    try {
      const handler = handlers[job.kind];
      if (!handler) throw new Error(`no handler for kind=${job.kind}`);
      await handler(job.payload, ctx);
      complete(db, job.id);
    } catch (err) {
      complete(db, job.id, { error: err.message ?? String(err) });
    } finally {
      inflight--;
      notifyDrain();
      wake();
    }
  }

  async function loop() {
    while (!stopped) {
      // Fill up to concurrency.
      while (!stopped && inflight < concurrency) {
        const job = claim(db);
        if (!job) break;
        runOne(job); // fire-and-forget; tracked by inflight
      }

      if (drainAndExit && inflight === 0) {
        const peek = db.prepare("SELECT 1 FROM jobs WHERE state='queued' LIMIT 1").get();
        if (!peek) break;
      }

      // Wait for either a wake event or the poll timer.
      await new Promise((resolve) => {
        wakeResolve = resolve;
        const timer = setTimeout(() => {
          if (wakeResolve === resolve) {
            wakeResolve = null;
            resolve();
          }
        }, POLL_INTERVAL_MS);
        // Ensure timer is cleared if we resolve via wake().
        timer.unref?.();
      });
    }

    // Drain phase: wait for in-flight jobs to finish.
    while (inflight > 0) {
      await new Promise((r) => drainListeners.push(r));
    }
    events.off('enqueued', wake);
  }

  const done = loop();

  return {
    /** Promise that resolves when the loop exits (only resolves naturally if drainAndExit). */
    done,
    /** Force-stop: drop queued work, wait for in-flight to finish. */
    async stop() {
      stopped = true;
      wake();
      await done;
    }
  };
}
