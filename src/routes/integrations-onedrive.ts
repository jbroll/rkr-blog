// Microsoft OneDrive picker integration. Per-user OAuth grant via
// Microsoft Entra ID with the Files.Read scope. Tokens stored encrypted
// in oauth_tokens, keyed by (user_id, 'onedrive'). Mirrors the gdrive
// integration module in shape.
//
// Routes:
//   GET  /admin/integrations/onedrive/connect       → redirect to Microsoft
//   GET  /admin/integrations/onedrive/callback      → exchange code, store tokens
//   GET  /admin/integrations/onedrive/status        → { connected: bool }
//   GET  /admin/integrations/onedrive/access-token  → fresh access token for picker
//   GET  /admin/integrations/onedrive/picker-config → { clientId, baseUrl }
//   POST /admin/integrations/onedrive/disconnect    → drop the row
//   POST /admin/import/onedrive                     → fetch + ingest a file by id
//
// The `picker-config` shape is intentionally lighter than gdrive's
// (no developerKey/appId): the Microsoft File Picker SDK takes app-id
// + base-tenant-url + the freshly-issued access token. The actual
// picker UI integration on the editor side is scaffolded as a manual
// item-id prompt for now; full SDK integration arrives once an MS
// Entra app is registered and end-to-end testing becomes possible.

import { Transform } from 'node:stream';

import { generateCodeVerifier, generateState, MicrosoftEntraId, type OAuth2Tokens } from 'arctic';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../lib/auth-middleware.ts';
import type { Db } from '../lib/db.ts';
import { fetchOneDriveFile } from '../lib/microsoft-graph.ts';
import {
  deleteToken,
  isExpired,
  readToken,
  type StoredOAuthToken,
  upsertToken
} from '../lib/oauth-tokens.ts';
import { ingestStream } from '../lib/originals.ts';
import { readSecretKey } from '../lib/secrets.ts';
import type { ProviderCallbackQuery, ProviderImportBody } from './integrations-shared.ts';

const PROVIDER = 'onedrive';
// Files.Read is the narrowest scope that lets us fetch user-selected
// files. offline_access yields a refresh_token so we can renew without
// re-prompting. Same pattern as gdrive's `drive.file`.
const SCOPES = ['Files.Read', 'offline_access'];
const STATE_COOKIE = 'rkr_onedrive_state';
const STATE_TTL_S = 600;

/** OAuth wire format used by integrations-onedrive. Tests inject a stub. */
export interface OneDriveTokenExchange {
  authorizationUrl(state: string, codeVerifier: string, scopes: string[]): URL;
  exchange(code: string, codeVerifier: string): Promise<OAuth2Tokens>;
  refresh(refreshToken: string, scopes: string[]): Promise<OAuth2Tokens>;
}

export interface IntegrationsOnedriveOpts {
  db: Db;
  siteRoot: string;
  /** Inject a stub TokenExchange so tests don't hit Microsoft. */
  exchange?: OneDriveTokenExchange;
  /** Inject a stub fetcher for Graph API calls. */
  graphFetcher?: typeof fetch;
  secureCookies?: boolean;
}

/** OneDrive's OAuth callback adds an `error_description` field beyond
 * the shared base. */
interface OneDriveCallbackQuery extends ProviderCallbackQuery {
  error_description?: string;
}

export default async function integrationsOnedriveRoutes(
  fastify: FastifyInstance,
  opts: IntegrationsOnedriveOpts
): Promise<void> {
  const { db, siteRoot, secureCookies = true } = opts;
  const exchange = opts.exchange ?? makeOneDriveExchange();
  const guard = { preHandler: requireUser };

  fastify.get('/admin/integrations/onedrive/connect', { ...guard }, async (_req, reply) => {
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const url = exchange.authorizationUrl(state, codeVerifier, SCOPES);
    // `prompt=consent` forces the consent screen so refresh_token issuance
    // is reliable. Microsoft yields refresh_token by default when
    // offline_access is in scope, but consent on first connect is the
    // safe choice — matches the gdrive flow.
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

  fastify.get<{ Querystring: OneDriveCallbackQuery }>(
    '/admin/integrations/onedrive/callback',
    { ...guard },
    async (req, reply) => {
      if (req.query.error) {
        const desc = req.query.error_description ? `: ${req.query.error_description}` : '';
        return reply.code(400).send({ error: `provider error: ${req.query.error}${desc}` });
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
        const raw = JSON.parse(cookieRaw) as Partial<{ state: unknown; codeVerifier: unknown }>;
        // JSON.parse succeeds on `{}` and arrays; a malformed cookie
        // would then leave parsed.state === undefined which matches
        // incomingState === undefined — silently bypassing the CSRF
        // check. Require both fields to be non-empty strings.
        if (typeof raw.state !== 'string' || typeof raw.codeVerifier !== 'string') {
          return reply.code(400).send({ error: 'malformed state cookie' });
        }
        parsed = { state: raw.state, codeVerifier: raw.codeVerifier };
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
        req.log.warn({ err }, 'onedrive token exchange failed');
        return reply.code(400).send({ error: 'token exchange failed' });
      }

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

  fastify.get('/admin/integrations/onedrive/picker-config', { ...guard }, async (_req, reply) => {
    const clientId = process.env.MICROSOFT_CLIENT_ID;
    if (!clientId) {
      return reply.code(404).send({ error: 'picker not configured (set MICROSOFT_CLIENT_ID)' });
    }
    return {
      clientId,
      // Tenant the picker SDK should target — 'common' lets both personal
      // and work accounts work. Override via env if a specific tenant is
      // needed (e.g. a corporate-only deployment).
      tenant: process.env.MICROSOFT_TENANT_ID ?? 'common'
    };
  });

  fastify.get('/admin/integrations/onedrive/status', { ...guard }, async (req) => {
    /* c8 ignore next */
    const user = req.user;
    /* c8 ignore next */
    if (!user) return { connected: false };
    const key = readSecretKey(siteRoot);
    const token = readToken(db, key, user.id, PROVIDER);
    return { connected: token !== null };
  });

  fastify.get('/admin/integrations/onedrive/access-token', { ...guard }, async (req, reply) => {
    const user = req.user;
    /* c8 ignore next 2 -- requireUser preHandler */
    if (!user) return reply.code(401).send({ error: 'unauthenticated' });
    const key = readSecretKey(siteRoot);
    const fresh = await ensureFresh(db, key, user.id, exchange);
    if (!fresh) return reply.code(404).send({ error: 'onedrive not connected' });
    return { accessToken: fresh.access_token, expiresAt: fresh.expires_at };
  });

  fastify.post('/admin/integrations/onedrive/disconnect', { ...guard }, async (req, reply) => {
    const user = req.user;
    /* c8 ignore next 2 -- requireUser preHandler */
    if (!user) return reply.code(401).send({ error: 'unauthenticated' });
    const removed = deleteToken(db, user.id, PROVIDER);
    return reply.send({ removed });
  });

  fastify.post<{ Body: ProviderImportBody }>(
    '/admin/import/onedrive',
    { ...guard },
    async (req, reply) => {
      const user = req.user;
      /* c8 ignore next 2 -- requireUser preHandler */
      if (!user) return reply.code(401).send({ error: 'unauthenticated' });
      const fileId = req.body?.fileId;
      if (typeof fileId !== 'string' || !fileId.trim()) {
        return reply.code(400).send({ error: 'fileId is required' });
      }
      const key = readSecretKey(siteRoot);
      const fresh = await ensureFresh(db, key, user.id, exchange);
      if (!fresh) return reply.code(412).send({ error: 'onedrive not connected' });

      let drive: Awaited<ReturnType<typeof fetchOneDriveFile>>;
      try {
        drive = await fetchOneDriveFile(fresh.access_token, fileId, {
          ...(opts.graphFetcher ? { fetcher: opts.graphFetcher } : {})
        });
      } catch (err) {
        req.log.warn({ err, fileId }, 'onedrive fetch failed');
        return reply.code(400).send({ error: (err as Error).message });
      }

      if (!/^image\//i.test(drive.contentType)) {
        return reply
          .code(415)
          .send({ error: `content-type must be image/*; got ${drive.contentType}` });
      }

      // Same 50 MiB streamed-bytes cap as /admin/import/url and
      // /admin/import/gdrive — defends against a multi-GB OneDrive file
      // being buffered to a tmp file before sharp's pixel-count guard
      // would otherwise fire.
      let bytes = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytes += chunk.length;
          if (bytes > ONEDRIVE_MAX_BYTES) {
            cb(new Error('streamed bytes exceeded limit'));
            return;
          }
          cb(null, chunk);
        }
      });

      try {
        const result = await ingestStream({
          stream: drive.body.pipe(limiter),
          siteRoot,
          source: {
            kind: 'onedrive',
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
        const msg = (err as Error).message;
        const code = /exceeded limit/.test(msg) ? 413 : 400;
        req.log.warn({ err, fileId }, 'onedrive ingest failed');
        return reply.code(code).send({ error: msg });
      }
    }
  );
}

/** Mirrors GDRIVE_MAX_BYTES + URL_FETCH_MAX_BYTES — keeps every
 * remote-import path bounded by the same per-request size cap. */
const ONEDRIVE_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Read the user's onedrive token; if expired and a refresh token
 * exists, exchange it for a fresh access token and persist. Returns
 * null when no token row exists at all.
 */
async function ensureFresh(
  db: Db,
  key: Buffer,
  userId: number,
  exchange: OneDriveTokenExchange
): Promise<StoredOAuthToken | null> {
  const existing = readToken(db, key, userId, PROVIDER);
  if (!existing) return null;
  if (!isExpired(existing)) return existing;
  if (!existing.refresh_token) return existing; // no refresh available; return as-is

  // Microsoft's refresh requires scopes (unlike Google, which infers
  // them from the original grant). Pass our canonical SCOPES list.
  const refreshed = await exchange.refresh(existing.refresh_token, SCOPES);
  upsertToken(db, key, {
    userId,
    provider: PROVIDER,
    accessToken: refreshed.accessToken(),
    refreshToken: refreshed.hasRefreshToken() ? refreshed.refreshToken() : existing.refresh_token,
    expiresAt: refreshed.accessTokenExpiresAt().toISOString(),
    scope: refreshed.hasScopes() ? refreshed.scopes().join(' ') : existing.scope
  });
  return readToken(db, key, userId, PROVIDER);
}

/* c8 ignore start -- production-only wiring; tests inject OneDriveTokenExchange */
function makeOneDriveExchange(): OneDriveTokenExchange {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  const baseUrl = process.env.PUBLIC_BASE_URL;
  // Tenant: 'common' supports both personal and work accounts; admins
  // can pin to a specific tenant or 'organizations' / 'consumers'.
  const tenant = process.env.MICROSOFT_TENANT_ID ?? 'common';
  if (!clientId || !clientSecret || !baseUrl) {
    throw new Error(
      'MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, and PUBLIC_BASE_URL must be set'
    );
  }
  const redirectURI = new URL('/admin/integrations/onedrive/callback', baseUrl).toString();
  const ms = new MicrosoftEntraId(tenant, clientId, clientSecret, redirectURI);
  return {
    authorizationUrl(state, codeVerifier, scopes) {
      return ms.createAuthorizationURL(state, codeVerifier, scopes);
    },
    exchange(code, codeVerifier) {
      return ms.validateAuthorizationCode(code, codeVerifier);
    },
    refresh(refreshToken, scopes) {
      return ms.refreshAccessToken(refreshToken, scopes);
    }
  };
}
/* c8 ignore stop */
