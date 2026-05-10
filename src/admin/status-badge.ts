// Status indicator badge (spec-offline §8).

import { $ } from './dom.ts';
import type { OnlineState } from './online-state.ts';
import { getState as getOnlineState, onChange as onOnlineChange } from './online-state.ts';
import { openStoragePanel } from './storage-panel.ts';
import type { DrainStatus } from './sync.ts';
import { getStatus as getDrainStatus, onStatus as onDrainStatus } from './sync.ts';

let onlineState: OnlineState = 'verifying';
let drainStatus: DrainStatus = { kind: 'idle' };

/** @public */
export function mountStatusBadge(): void {
  /* v8 ignore next 2 -- badge ships in the admin template */
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

  badge.addEventListener('click', () => void openStoragePanel());
}

function render(): void {
  const dot = $<HTMLSpanElement>('rkr-sync-badge').querySelector<HTMLSpanElement>('.rkr-sync-dot');
  const text =
    $<HTMLSpanElement>('rkr-sync-badge').querySelector<HTMLSpanElement>('.rkr-sync-text');
  /* v8 ignore next -- DOM children template-fixed */
  if (!dot || !text) return;

  // Actionable drain status (pending count, conflict, halt) takes
  // precedence over connectivity in the badge text.
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
  dot.className = `rkr-sync-dot is-${onlineState}`;
  text.textContent = onlineState;
}
