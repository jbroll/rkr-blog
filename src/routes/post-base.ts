// Compare-and-swap for the post save baseline. The client must echo
// the exact updatedAt it was last given; a mismatch in either
// direction is a conflict. Exact equality is what lets a future-dated
// mtime be recovered in-app — a clamped inequality 409s forever
// because no header value can ever satisfy it.

/** Whole-ms ISO, matching what the save route echoes back. mtimeMs is
 * a sub-ms float on some filesystems and the header round-trips
 * through Date.parse, so both sides must floor. */
export function postUpdatedAt(mtimeMs: number): string {
  return new Date(Math.floor(mtimeMs)).toISOString();
}

type BaseVerdict =
  | { kind: 'no-baseline' }
  | { kind: 'invalid' }
  | { kind: 'superseded'; serverUpdatedAt: string }
  | { kind: 'ok' };

export function evaluatePostBase(header: string | undefined, mtimeMs: number): BaseVerdict {
  if (typeof header !== 'string') return { kind: 'no-baseline' };
  const claimedMs = Date.parse(header);
  if (Number.isNaN(claimedMs)) return { kind: 'invalid' };
  const serverMs = Math.floor(mtimeMs);
  if (serverMs !== claimedMs) {
    return { kind: 'superseded', serverUpdatedAt: postUpdatedAt(serverMs) };
  }
  return { kind: 'ok' };
}
