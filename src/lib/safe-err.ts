/**
 * Extracts a safe subset of an error for logging on OAuth / token-exchange
 * paths. Logs on those paths must never serialize the full error object,
 * which may embed authorization codes, client secrets, or refresh tokens
 * from a misconfig provider response envelope.
 *
 * Protection is two-layered:
 *  1. Field allowlist — only name/message/code are kept; response, body,
 *     cause, config, etc. are never included.
 *  2. Message redaction (best-effort) — common secret key=value pairs,
 *     long opaque tokens (≥40 base64url chars), JWT-shaped strings, and
 *     bearer tokens (`Authorization: Bearer <value>`) are replaced with
 *     `[redacted]`. Long non-secret identifiers may also be redacted; that
 *     is acceptable for an error log.
 *     Limitation: a keyless standard-base64 token containing `+` or `/`
 *     (not base64url) may only be partially redacted by the long-token rule
 *     since `+`/`/` are not in the matched charset — best-effort for error
 *     logs.
 */

function redact(msg: string): string {
  return (
    msg
      // (1) dotted JWT (header.payload.sig) — run FIRST so the eyJ prefix is intact
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
      // (2) bearer token value — must run BEFORE key=value rule so the full
      //     "Bearer <token>" is consumed before "authorization: Bearer" matches
      //     only the keyword "Bearer" and leaves the token value exposed
      .replace(/\bbearer\s+\S+/gi, 'bearer [redacted]')
      // (3) key=value / key: value secret pairs (token/code/secret-ish keys)
      .replace(
        /\b(access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|authorization|bearer|code|password|secret|api[_-]?key)\b\s*[=:]\s*\S+/gi,
        '$1=[redacted]'
      )
      // (4) long opaque tokens (>=40 base64url chars) — catches anything not already redacted
      .replace(/[A-Za-z0-9_-]{40,}/g, '[redacted]')
  );
}

export function safeErr(err: unknown): { name?: string; message?: string; code?: string } {
  if (err && typeof err === 'object') {
    const e = err as { name?: unknown; message?: unknown; code?: unknown };
    return {
      name: typeof e.name === 'string' ? e.name : undefined,
      message: typeof e.message === 'string' ? redact(e.message) : undefined,
      code: typeof e.code === 'string' ? e.code : undefined
    };
  }
  return { message: typeof err === 'string' ? redact(err) : undefined };
}
