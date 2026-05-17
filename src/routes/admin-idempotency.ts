// Shared outbox idempotency-key parsing (Task 8). Used by both the
// savePost handler (admin.ts) and the commitImageEdit handler
// (admin-sidecar-edit.ts) so the (device_id, seq) key is read the
// same way everywhere. No Fastify/route-closure coupling — pure.

/** Parse the outbox idempotency key from request headers. Returns
 * null unless BOTH a non-empty x-rkr-device-id and a finite integer
 * x-rkr-outbox-seq are present. Only drained outbox entries carry
 * both; the online direct POST in save.ts carries neither, so it is
 * never treated as a replay. */
export function readIdempotencyKey(
  headers: Record<string, string | string[] | undefined>
): { deviceId: string; seq: number } | null {
  const deviceId = headers['x-rkr-device-id'];
  const seqRaw = headers['x-rkr-outbox-seq'];
  const seq = typeof seqRaw === 'string' ? Number.parseInt(seqRaw, 10) : Number.NaN;
  if (typeof deviceId === 'string' && deviceId !== '' && Number.isFinite(seq)) {
    return { deviceId, seq };
  }
  return null;
}
