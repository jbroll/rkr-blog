/**
 * Extracts a safe subset of an error for logging on OAuth / token-exchange
 * paths. Logs on those paths must never serialize the full error object,
 * which may embed authorization codes, client secrets, or refresh tokens
 * from a misconfig provider response envelope.
 *
 * Note: we strip non-allowlisted *fields* (response, body, cause, config,
 * etc.) but do NOT scrub message content — if a provider embeds a token
 * inside a human-readable message string, that string still passes through.
 * The primary protection is refusing to serialize the whole object.
 */
export function safeErr(err: unknown): { name?: string; message?: string; code?: string } {
  if (err && typeof err === 'object') {
    const e = err as { name?: unknown; message?: unknown; code?: unknown };
    return {
      name: typeof e.name === 'string' ? e.name : undefined,
      message: typeof e.message === 'string' ? e.message : undefined,
      code: typeof e.code === 'string' ? e.code : undefined
    };
  }
  return { message: typeof err === 'string' ? err : undefined };
}
