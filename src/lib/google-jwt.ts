// Google ID-token verification. Uses Google's JWKS endpoint and `jose`
// for signature, expiry, issuer, and audience checks.
//
// We expose IdTokenVerifier as an injectable interface so tests can pass
// a stub that returns a parsed payload directly without contacting
// Google. Production wiring (makeGoogleVerifier) is the only place
// `aud` and `iss` are enforced — never bypass it outside tests.

import { createRemoteJWKSet, jwtVerify } from 'jose';

import type { GoogleIdPayload } from '../routes/auth.ts';

export interface IdTokenVerifier {
  /** Reject (throw) on signature, expiry, issuer, or audience mismatch. */
  verify(idToken: string): Promise<GoogleIdPayload>;
}

const GOOGLE_JWKS_URL = new URL('https://www.googleapis.com/oauth2/v3/certs');
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/* c8 ignore start -- production-only wiring; tests inject a stub IdTokenVerifier */
export function makeGoogleVerifier(audience: string): IdTokenVerifier {
  const jwks = createRemoteJWKSet(GOOGLE_JWKS_URL);
  return {
    async verify(idToken: string): Promise<GoogleIdPayload> {
      const { payload } = await jwtVerify(idToken, jwks, {
        issuer: GOOGLE_ISSUERS,
        audience
      });
      return payload as unknown as GoogleIdPayload;
    }
  };
}
/* c8 ignore stop */
