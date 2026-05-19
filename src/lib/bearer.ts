/** Extract the bearer token from an Authorization header value (RFC 6750).
 * Returns the token string for a well-formed "Bearer <token>" header,
 * or undefined if absent, bare ("Bearer"), or otherwise malformed. */
export function parseBearerToken(auth: string | undefined): string | undefined {
  if (!auth) return undefined;
  const m = /^bearer\s+(\S+)$/i.exec(auth);
  return m?.[1];
}
