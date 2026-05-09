// Status indicator (spec-offline.md §8). Bottom-right corner of
// #rkroll-admin-root, subscribes to:
//
//   • online-state.onChange → connectivity (online / verifying / offline)
//   • sync.onStatus         → drain progress (idle / draining N / halted / conflict)
//
// The two streams compose into a single label so the user sees one
// authoritative status instead of two competing badges. Click opens
// the storage panel; phase 1j ships a placeholder message and
// phase 3 wires the real panel (pinned/cached lists, sync-now,
// evict-all per spec-offline §8 storage panel contract).

import { $, setStatus } from './dom.ts';
import type { OnlineState } from './online-state.ts';
import { getState as getOnlineState, onChange as onOnlineChange } from './online-state.ts';
import type { DrainStatus } from './sync.ts';
import { getStatus as getDrainStatus, onStatus as onDrainStatus } from './sync.ts';

let onlineState: OnlineState = 'verifying';
let drainStatus: DrainStatus = { kind: 'idle' };

/** Wire the badge: hook the two streams, render, retain handlers
 * for the SPA lifetime. Idempotent — re-mount during a hot reload
 * would be safe but the SPA doesn't trigger that path today.
 * @public */
export function mountStatusBadge(): void {
  /* v8 ignore next 3 -- defensive: the badge element ships in the
     admin template; missing-it would mean a corrupt build */
  const badge = document.getElementById('rkr-sync-badge');
  if (!badge) return;

  onlineState = getOnlineState();
  drainStatus = getDrainStatus();
  render();

  onOnlineChange((s) => {
    onlineState = s;
    render();
  });
  onDrainStatus((s) => {
    drainStatus = s;
    render();
  });

  badge.addEventListener('click', openStoragePanel);
}

function render(): void {
  const dot = $<HTMLSpanElement>('rkr-sync-badge').querySelector<HTMLSpanElement>('.rkr-sync-dot');
  const text =
    $<HTMLSpanElement>('rkr-sync-badge').querySelector<HTMLSpanElement>('.rkr-sync-text');
  /* v8 ignore next -- DOM children always present (template-fixed) */
  if (!dot || !text) return;

  // Drain status overrides connectivity in the badge text when it
  // carries actionable information (queued count or a conflict).
  if (drainStatus.kind === 'conflict') {
    dot.className = 'rkr-sync-dot is-conflict';
    text.textContent = `conflict on /${drainStatus.slug}`;
    return;
  }
  if (drainStatus.kind === 'halted') {
    dot.className = 'rkr-sync-dot is-conflict';
    text.textContent = `halted: ${drainStatus.reason}`;
    return;
  }
  if (drainStatus.kind === 'draining' && drainStatus.remaining > 0) {
    dot.className = `rkr-sync-dot is-${onlineState}`;
    text.textContent = `${drainStatus.remaining} pending`;
    return;
  }
  // Idle drain → connectivity is the headline.
  dot.className = `rkr-sync-dot is-${onlineState}`;
  text.textContent = onlineState;
}

/** Placeholder click handler. Phase 3 replaces this with the real
 * storage panel (pinned/cached lists + sync-now + evict-all). For
 * phase 1j we surface a status-line breadcrumb so the click is at
 * least observable in e2e — the user-facing message is intentionally
 * minimal. */
/* v8 ignore start -- placeholder UI; the click handler is exercised
   only when phase 3 lands the real panel */
function openStoragePanel(): void {
  setStatus('storage panel coming in phase 3');
}
/* v8 ignore stop */
