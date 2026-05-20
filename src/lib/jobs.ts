// Job queue. The `jobs` SQLite table is the queue (no Redis, no BullMQ
// — see implementation.md §1 stack and §6 worker lifecycle). One worker
// codepath drives the queue from two
// contexts: inside Fastify (in-process worker, woken by EventEmitter
// on enqueue) and inside `site-admin render` (drains and exits).
//
// Concurrency safety relies on `UPDATE … WHERE state='queued' RETURNING id`
// — only one worker's UPDATE will see the row in queued state. Other
// workers' UPDATEs will return zero rows.

import { EventEmitter } from 'node:events';
import os from 'node:os';
import { envClassifier, makeClassifyHandler } from './classify-handler.ts';
import type { Db } from './db.ts';
import { envMailer } from './mailer.ts';
import { makeNotifyHandler } from './notify-handler.ts';
import type { DerivativeArgs } from './render.ts';
import { renderDerivative } from './render.ts';

// Process-local wakeup signal. workQueue() listens for 'enqueued'.
// One emitter per process is sufficient: SQLite is the source of truth;
// EventEmitter is just a latency optimization over polling.
export const events = new EventEmitter();

const POLL_INTERVAL_MS = 250;
const MAX_JOB_ATTEMPTS = 5;

// Live-render gauge. Live /img requests render inline in the
// request handler; while any are in flight, the worker pauses
// pre-warm jobs so the two don't contend for libvips threads.
// Pre-warm is opportunistic — it only runs when the box is idle.
let liveInflight = 0;

/** Increment / decrement the live-render gauge. publicRoutes wraps
 * its inline renderDerivative calls; the worker checks this before
 * claiming a job.
 * @public */
export function noteLiveRender(delta: 1 | -1): void {
  liveInflight = Math.max(0, liveInflight + delta);
  if (liveInflight === 0) events.emit('enqueued', { id: -1, kind: 'render' });
}

/** @public */
export function liveRendersInFlight(): boolean {
  return liveInflight > 0;
}

type JobKind = 'render' | 'classify' | 'notify';

export interface RenderPayload extends DerivativeArgs {}

export interface EnqueueArgs<P = unknown> {
  kind: JobKind;
  payload: P;
  cacheKey?: string;
}

export interface EnqueueResult {
  id: number;
  duplicate: boolean;
}

export interface ClaimedJob<P = unknown> {
  id: number;
  kind: JobKind;
  payload: P;
}

export interface JobHandlerCtx {
  siteRoot: string;
  [k: string]: unknown;
}

export type JobHandler<P = unknown> = (payload: P, ctx: JobHandlerCtx) => Promise<void>;

export type JobHandlerMap = Partial<Record<JobKind, JobHandler<unknown>>>;

interface JobRow {
  id: number;
  kind: JobKind;
  payload: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  attempts: number;
}

/**
 * Enqueue a job. The schema enforces `cache_key UNIQUE`, so when a row with
 * the same cacheKey already exists:
 *   - state queued or running          → return the existing id (duplicate).
 *   - state failed, attempts exhausted → return as duplicate (poison-pill guard).
 *   - state done or failed (retryable) → reset that row back to queued.
 */
export function enqueue<P>(db: Db, { kind, payload, cacheKey }: EnqueueArgs<P>): EnqueueResult {
  const now = new Date().toISOString();

  if (cacheKey) {
    const existing = db
      .prepare<Pick<JobRow, 'id' | 'state' | 'attempts'>>(
        'SELECT id, state, attempts FROM jobs WHERE cache_key = ?'
      )
      .get(cacheKey);
    if (existing) {
      if (existing.state === 'queued' || existing.state === 'running') {
        return { id: existing.id, duplicate: true };
      }
      if (existing.state === 'failed' && existing.attempts >= MAX_JOB_ATTEMPTS) {
        // Permanently failed — don't re-queue a poison-pill job forever.
        return { id: existing.id, duplicate: true };
      }
      // done or failed (under attempt limit) → reset to queued.
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

/** Atomically claim one queued job. Returns null if none available.
 *
 * Two-statement pattern (SELECT-then-UPDATE) instead of a single
 * UPDATE...RETURNING with ORDER BY because better-sqlite3 doesn't
 * support that combination. The race window between the two
 * statements is closed by the UPDATE's `state='queued'` predicate +
 * RETURNING: if another worker claimed the same id first, the
 * UPDATE matches zero rows and `claimed` is undefined — we return
 * null instead of double-claiming. */
export function claim<P = unknown>(db: Db): ClaimedJob<P> | null {
  const candidate = db
    .prepare<Pick<JobRow, 'id' | 'kind' | 'payload'>>(
      "SELECT id, kind, payload FROM jobs WHERE state='queued' ORDER BY created_at, id LIMIT 1"
    )
    .get();
  if (!candidate) return null;

  const now = new Date().toISOString();
  const claimed = db
    .prepare<{ id: number }>(
      `UPDATE jobs SET state='running', updated_at=?, attempts=attempts+1
       WHERE id=? AND state='queued'
       RETURNING id`
    )
    .get(now, candidate.id);
  if (!claimed) return null;

  return {
    id: candidate.id,
    kind: candidate.kind,
    payload: JSON.parse(candidate.payload) as P
  };
}

/** Mark a job done (no error) or failed (with error message). */
export function complete(db: Db, id: number, opts: { error?: string } = {}): void {
  const now = new Date().toISOString();
  if (opts.error) {
    db.prepare("UPDATE jobs SET state='failed', error=?, updated_at=? WHERE id=?").run(
      String(opts.error).slice(0, 4000),
      now,
      id
    );
  } else {
    db.prepare("UPDATE jobs SET state='done', updated_at=? WHERE id=?").run(now, id);
  }
}

/** Default handler for `kind: 'render'` jobs. Calls renderDerivative. */
export const renderHandler: JobHandler<RenderPayload> = async (payload, ctx) => {
  const { originalId, ops, variant, output } = payload;
  await renderDerivative({ originalId, ops, variant, output, siteRoot: ctx.siteRoot });
};

const DEFAULT_HANDLERS: JobHandlerMap = {
  render: renderHandler as JobHandler<unknown>,
  classify: makeClassifyHandler(envClassifier(), enqueue) as JobHandler<unknown>,
  notify: makeNotifyHandler(envMailer()) as JobHandler<unknown>
};

export interface WorkQueueArgs {
  db: Db;
  ctx: JobHandlerCtx;
  handlers?: JobHandlerMap;
  concurrency?: number;
  drainAndExit?: boolean;
}

export interface WorkQueueController {
  /** Resolves when the loop exits (naturally on drain if drainAndExit, else after stop()). */
  done: Promise<void>;
  /** Force-stop: drop queued work, wait for in-flight to finish. */
  stop(): Promise<void>;
}

/**
 * Run the worker loop. When `drainAndExit: true`, the loop exits as soon as
 * the queue is empty (used by `site-admin render`).
 */
export function workQueue({
  db,
  ctx,
  handlers = DEFAULT_HANDLERS,
  concurrency = Math.max(1, os.cpus().length),
  drainAndExit = false
}: WorkQueueArgs): WorkQueueController {
  let stopped = false;
  let inflight = 0;
  let wakeResolve: (() => void) | null = null;
  const drainListeners: Array<() => void> = [];

  function wake(): void {
    if (wakeResolve) {
      const r = wakeResolve;
      wakeResolve = null;
      r();
    }
  }

  function notifyDrain(): void {
    if (inflight === 0) {
      while (drainListeners.length) {
        const r = drainListeners.shift();
        r?.();
      }
    }
  }

  events.on('enqueued', wake);

  async function runOne(job: ClaimedJob): Promise<void> {
    inflight++;
    try {
      const handler = handlers[job.kind];
      if (!handler) throw new Error(`no handler for kind=${job.kind}`);
      await handler(job.payload, ctx);
      complete(db, job.id);
    } catch (err) {
      complete(db, job.id, { error: (err as Error).message ?? String(err) });
    } finally {
      inflight--;
      notifyDrain();
      wake();
    }
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      // Pause pre-warm while live requests are rendering — they
      // share libvips threads. The wake() emitted by noteLiveRender
      // when the gauge hits 0 unblocks us promptly.
      while (!stopped && inflight < concurrency && !liveRendersInFlight()) {
        const job = claim(db);
        if (!job) break;
        // Fire-and-forget; tracked by inflight.
        void runOne(job);
      }

      if (drainAndExit && inflight === 0) {
        const peek = db.prepare("SELECT 1 FROM jobs WHERE state='queued' LIMIT 1").get();
        if (!peek) break;
      }

      // Wait for either a wake event or the poll timer.
      await new Promise<void>((resolve) => {
        wakeResolve = resolve;
        const timer = setTimeout(() => {
          if (wakeResolve === resolve) {
            wakeResolve = null;
            resolve();
          }
        }, POLL_INTERVAL_MS);
        timer.unref?.();
      });
    }

    // Drain phase: wait for in-flight jobs to finish.
    while (inflight > 0) {
      await new Promise<void>((r) => drainListeners.push(r));
    }
    events.off('enqueued', wake);
  }

  const done = loop();

  return {
    done,
    async stop() {
      stopped = true;
      wake();
      await done;
    }
  };
}
