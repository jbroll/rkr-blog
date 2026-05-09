// Shared fixtures for the gdrive + onedrive integration tests. Both
// providers exchange tokens via arctic's `OAuth2Tokens` interface, so
// the stub shape is identical; the response bodies the routes emit
// also share a structure (status, access-token, import success).
//
// Keeping these in one place avoids type-name collisions between the
// two test files and trims the duplicate-type allowlist.

// ---- response body shapes (assertion targets) -------------------------

/** Universal Fastify error envelope — every route in this app emits
 * `{ error: <string> }` on failure. Shared with non-OAuth tests too;
 * lives here because this module is the only place tests look for
 * shared response shapes. */
export interface ErrorBody {
  error: string;
}

export interface StatusBody {
  connected: boolean;
}

export interface AccessBody {
  accessToken: string;
  expiresAt: string;
}

export interface ImportResponseBody {
  id: string;
  bytes: number;
  ext: string;
  deduplicated: boolean;
}

// ---- arctic OAuth2Tokens stub -----------------------------------------

export interface StubTokens {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds?: number;
  scopes?: string[];
}

export interface StubOpts {
  exchangeReturns?: StubTokens;
  refreshReturns?: StubTokens;
  exchangeThrows?: Error;
}

/** Fabricate an arctic-compatible OAuth2Tokens object. The route only
 * touches the methods listed below; the rest are no-ops included to
 * keep the structural type happy. */
export function stubOAuth2Tokens(t: StubTokens) {
  const expiresAt = new Date(Date.now() + (t.expiresInSeconds ?? 3600) * 1000);
  return {
    accessToken: () => t.accessToken,
    accessTokenExpiresAt: () => expiresAt,
    accessTokenExpiresInSeconds: () => t.expiresInSeconds ?? 3600,
    hasRefreshToken: () => t.refreshToken !== undefined,
    refreshToken: () => t.refreshToken ?? '',
    hasScopes: () => (t.scopes?.length ?? 0) > 0,
    scopes: () => t.scopes ?? [],
    tokenType: () => 'Bearer',
    idToken: () => '',
    data: {}
  };
}
