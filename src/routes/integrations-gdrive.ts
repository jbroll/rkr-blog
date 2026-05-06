// Google Drive picker integration. Per-user OAuth grant with the
// drive.file scope (only files the user creates or opens via Picker —
// avoids broad-access verification). Tokens stored encrypted in
// oauth_tokens, keyed by (user_id, 'gdrive').
//
// Routes:
//   GET  /admin/integrations/gdrive/connect       → redirect to Google
//   GET  /admin/integrations/gdrive/callback      → exchange code, store tokens
//   GET  /admin/integrations/gdrive/status        → { connected: bool }
//   GET  /admin/integrations/gdrive/access-token  → fresh access token for Picker
//   POST /admin/integrations/gdrive/disconnect    → drop the row
//   POST /admin/import/gdrive                     → fetch + ingest a file by id

import { Google, generateCodeVerifier, generateState, type OAuth2Tokens } from 'arctic';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../lib/auth-middleware.ts';
import type { Db } from '../lib/db.ts';
import { fetchDriveFile } from '../lib/google-drive.ts';
import {
  deleteToken,
  isExpired,
  readToken,
  type StoredOAuthToken,
  upsertToken
} from '../lib/oauth-tokens.ts';
import { ingestStream } from '../lib/originals.ts';
import { readSecretKey } from '../lib/secrets.ts';

const PROVIDER = 'gdrive';
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const STATE_COOKIE = 'rkr_gdrive_state';
const STATE_TTL_S = 600;

/** OAuth wire format used by integrations-gdrive. Tests inject a stub. */
export interface DriveTokenExchange {
  authorizationUrl(state: string, codeVerifier: string, scopes: string[]): URL;
  exchange(code: string, codeVerifier: string): Promise<OAuth2Tokens>;
  refresh(refreshToken: string): Promise<OAuth2Tokens>;
}

export interface IntegrationsGdriveOpts {
  db: Db;
  siteRoot: string;
  /** Inject a stub TokenExchange / fetch so tests don't hit Google. */
  exchange?: DriveTokenExchange;
  /** Inject a stub fetcher for Drive API calls. */
  driveFetcher?: typeof fetch;
  secureCookies?: boolean;
}

interface ImportBody {
  fileId?: unknown;
  name?: unknown;
  mimeType?: unknown;
}

interface CallbackQuery {
  code?: string;
  state?: string;
  error?: string;
}

export default async function integrationsGdriveRoutes(
  fastify: FastifyInstance,
  opts: IntegrationsGdriveOpts
): Promise<void> {
  const { db, siteRoot, secureCookies = true } = opts;
  const exchange = opts.exchange ?? makeDriveExchange();
  const guard = { preHandler: requireUser };

  fastify.get('/admin/integrations/gdrive/connect', { ...guard }, async (_req, reply) => {
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const url = exchange.authorizationUrl(state, codeVerifier, SCOPES);
    // Force refresh_token issuance even if user has previously consented.
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');

    reply.setCookie(STATE_COOKIE, JSON.stringify({ state, codeVerifier }), {
      httpOnly: true,
      secure: secureCookies,
      sameSite: 'lax',
      path: '/',
      maxAge: STATE_TTL_S
    });
    return reply.redirect(url.toString(), 302);
  });

  fastify.get<{ Querystring: CallbackQuery }>(
    '/admin/integrations/gdrive/callback',
    { ...guard },
    async (req, reply) => {
      if (req.query.error) {
        return reply.code(400).send({ error: `provider error: ${req.query.error}` });
      }
      const code = req.query.code;
      const incomingState = req.query.state;
      if (typeof code !== 'string' || typeof incomingState !== 'string') {
        return reply.code(400).send({ error: 'missing code or state' });
      }
      const cookieRaw = (req.cookies as Record<string, string | undefined> | undefined)?.[
        STATE_COOKIE
      ];
      if (!cookieRaw) return reply.code(400).send({ error: 'no state cookie' });

      let parsed: { state: string; codeVerifier: string };
      try {
        parsed = JSON.parse(cookieRaw);
      } catch {
        return reply.code(400).send({ error: 'malformed state cookie' });
      }
      if (parsed.state !== incomingState) {
        return reply.code(400).send({ error: 'state mismatch' });
      }
      reply.clearCookie(STATE_COOKIE, {
        httpOnly: true,
        secure: secureCookies,
        sameSite: 'lax',
        path: '/'
      });

      let tokens: OAuth2Tokens;
      try {
        tokens = await exchange.exchange(code, parsed.codeVerifier);
      } catch (err) {
        req.log.warn({ err }, 'gdrive token exchange failed');
        return reply.code(400).send({ error: 'token exchange failed' });
      }

      // Store the tokens. user is guaranteed by requireUser preHandler.
      const user = req.user;
      /* c8 ignore next -- requireUser preHandler ensures user is non-null */
      if (!user) return reply.code(401).send({ error: 'unauthenticated' });
      const key = readSecretKey(siteRoot);
      upsertToken(db, key, {
        userId: user.id,
        provider: PROVIDER,
        accessToken: tokens.accessToken(),
        refreshToken: tokens.hasRefreshToken() ? tokens.refreshToken() : null,
        expiresAt: tokens.accessTokenExpiresAt().toISOString(),
        scope: tokens.hasScopes() ? tokens.scopes().join(' ') : null
      });

      return reply.redirect('/admin/editor', 302);
    }
  );

  fastify.get('/admin/integrations/gdrive/status', { ...guard }, async (req) => {
    /* c8 ignore next -- requireUser preHandler */
    const user = req.user;
    /* c8 ignore next */
    if (!user) return { connected: false };
    const key = readSecretKey(siteRoot);
    const token = readToken(db, key, user.id, PROVIDER);
    return { connected: token !== null };
  });

  fastify.get('/admin/integrations/gdrive/access-token', { ...guard }, async (req, reply) => {
    const user = req.user;
    /* c8 ignore next 2 -- requireUser preHandler */
    if (!user) return reply.code(401).send({ error: 'unauthenticated' });
    const key = readSecretKey(siteRoot);
    const fresh = await ensureFresh(db, key, user.id, exchange);
    if (!fresh) return reply.code(404).send({ error: 'gdrive not connected' });
    return { accessToken: fresh.access_token, expiresAt: fresh.expires_at };
  });

  fastify.post('/admin/integrations/gdrive/disconnect', { ...guard }, async (req, reply) => {
    const user = req.user;
    /* c8 ignore next 2 -- requireUser preHandler */
    if (!user) return reply.code(401).send({ error: 'unauthenticated' });
    const removed = deleteToken(db, user.id, PROVIDER);
    return reply.send({ removed });
  });

  fastify.post<{ Body: ImportBody }>('/admin/import/gdrive', { ...guard }, async (req, reply) => {
    const user = req.user;
    /* c8 ignore next 2 -- requireUser preHandler */
    if (!user) return reply.code(401).send({ error: 'unauthenticated' });
    const fileId = req.body?.fileId;
    if (typeof fileId !== 'string' || !fileId.trim()) {
      return reply.code(400).send({ error: 'fileId is required' });
    }
    const key = readSecretKey(siteRoot);
    const fresh = await ensureFresh(db, key, user.id, exchange);
    if (!fresh) return reply.code(412).send({ error: 'gdrive not connected' });

    let drive: Awaited<ReturnType<typeof fetchDriveFile>>;
    try {
      drive = await fetchDriveFile(fresh.access_token, fileId, {
        ...(opts.driveFetcher ? { fetcher: opts.driveFetcher } : {})
      });
    } catch (err) {
      req.log.warn({ err, fileId }, 'drive fetch failed');
      return reply.code(400).send({ error: (err as Error).message });
    }

    if (!/^image\//i.test(drive.contentType)) {
      return reply
        .code(415)
        .send({ error: `content-type must be image/*; got ${drive.contentType}` });
    }

    try {
      const result = await ingestStream({
        stream: drive.body,
        siteRoot,
        source: {
          kind: 'gdrive',
          originalName: drive.file.name,
          fileId: drive.file.id
        }
      });
      return {
        id: result.id,
        bytes: result.bytes,
        deduplicated: result.deduplicated,
        ext: result.ext
      };
    } catch (err) {
      req.log.warn({ err, fileId }, 'gdrive ingest failed');
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
}

/**
 * Read the user's gdrive token; if expired and a refresh token exists,
 * exchange it for a fresh access token and persist. Returns null when
 * no token row exists at all.
 */
async function ensureFresh(
  db: Db,
  key: Buffer,
  userId: number,
  exchange: DriveTokenExchange
): Promise<StoredOAuthToken | null> {
  const existing = readToken(db, key, userId, PROVIDER);
  if (!existing) return null;
  if (!isExpired(existing)) return existing;
  if (!existing.refresh_token) return existing; // no refresh available; return as-is

  const refreshed = await exchange.refresh(existing.refresh_token);
  upsertToken(db, key, {
    userId,
    provider: PROVIDER,
    accessToken: refreshed.accessToken(),
    // Google often omits refresh_token on refresh; preserve the existing one.
    refreshToken: refreshed.hasRefreshToken() ? refreshed.refreshToken() : existing.refresh_token,
    expiresAt: refreshed.accessTokenExpiresAt().toISOString(),
    scope: refreshed.hasScopes() ? refreshed.scopes().join(' ') : existing.scope
  });
  return readToken(db, key, userId, PROVIDER);
}

/* c8 ignore start -- production-only wiring; tests inject DriveTokenExchange */
function makeDriveExchange(): DriveTokenExchange {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const baseUrl = process.env.PUBLIC_BASE_URL;
  if (!clientId || !clientSecret || !baseUrl) {
    throw new Error('GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and PUBLIC_BASE_URL must be set');
  }
  const redirectURI = new URL('/admin/integrations/gdrive/callback', baseUrl).toString();
  const google = new Google(clientId, clientSecret, redirectURI);
  return {
    authorizationUrl(state, codeVerifier, scopes) {
      return google.createAuthorizationURL(state, codeVerifier, scopes);
    },
    exchange(code, codeVerifier) {
      return google.validateAuthorizationCode(code, codeVerifier);
    },
    refresh(refreshToken) {
      return google.refreshAccessToken(refreshToken);
    }
  };
}
/* c8 ignore stop */
