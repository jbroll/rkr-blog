// Startup sequence for the admin SPA's offline infrastructure.
// Runs once per mount; main.ts kicks it off as fire-and-forget.
//
// Steps in order:
//   1. ensureSchema()   initialize / migrate opfs://meta/_root.json
//   2. pendingCount()   surface "N pending offline edit(s)" if any
//   3. startOnline()    begin the online/offline state machine
//   4. tryDrain()       attempt a drain pass (no-op until phase 1f
//                       registers per-op drainers)
//
// Lives in its own module so main.ts stays at the 500-line cap and
// the offline-init order has one obvious home.

import { setStatus } from './dom.ts';
import { start as startOnline } from './online-state.ts';
import { ensureSchema } from './opfs-schema.ts';
import { pendingCount } from './outbox.ts';
import { tryDrain } from './sync.ts';

export async function startOfflineInfrastructure(): Promise<void> {
  try {
    await ensureSchema();
    const pending = await pendingCount();
    if (pending > 0) setStatus(`${pending} pending offline edit(s)`);
    startOnline();
    await tryDrain();
  } catch (err) {
    setStatus(`offline cache init failed: ${(err as Error).message}`);
  }
}
