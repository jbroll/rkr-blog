// Fastify app factory. Exports buildApp() so tests can drive the server
// without binding a port, and startServer() for the bin entry point.

import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import Fastify from 'fastify';
import sharp from 'sharp';

// Cap libvips threads per render: a single sharp call can otherwise
// peg every core. Combined with worker concurrency=1 below, this
// caps total render CPU at ~1 core, leaving room for live serving.
sharp.concurrency(1);

import { registerAuthMiddleware } from './lib/auth-middleware.ts';
import { resolveGitHash } from './lib/build-info.ts';
import { paths, serverConfig } from './lib/config.ts';
import { registerCsrfGuard } from './lib/csrf.ts';
import { type Db, open } from './lib/db.ts';
import type { IdTokenVerifier } from './lib/google-jwt.ts';
import { workQueue } from './lib/jobs.ts';
import adminRoutes from './routes/admin.ts';
import type { UrlFetcher } from './routes/admin-import-url.ts';
import authRoutes, { type TokenExchange } from './routes/auth.ts';
import integrationsGdriveRoutes, { type DriveTokenExchange } from './routes/integrations-gdrive.ts';
import integrationsOnedriveRoutes, {
  type OneDriveTokenExchange
} from './routes/integrations-onedrive.ts';
import publicRoutes from './routes/public.ts';

const UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024; // 100 MiB cap on a single file

export interface BuildAppOpts {
  logger?: FastifyServerOptions['logger'];
  siteRoot?: string;
  /** When provided, GET /img/* registers and (unless suppressed) the worker starts. */
  db?: Db;
  /** Wall-clock budget for synchronous render on cache miss (ms). Default 30s. */
  renderBudgetMs?: number;
  /** Disable starting the in-process worker (e.g. in tests). Default true if db provided. */
  startWorker?: boolean;
  /** Override the admin bundle dir (default: <repo>/static/admin). */
  adminBundleDir?: string;
  /** Override the URL-import fetcher (tests use plain `fetch` to skip the
   * SSRF guard against fixture servers on 127.0.0.1). */
  urlFetcher?: UrlFetcher;
  /**
   * When set, /admin/auth routes register and admin routes are gated.
   * Test suites that don't want auth gating can omit this — auth wiring is
   * skipped and request.user stays null. (Production startServer always
   * provides auth wiring via env vars.)
   */
  auth?: {
    exchange?: TokenExchange;
    /** Production verifies via Google's JWKS; tests inject a stub. */
    verifier?: IdTokenVerifier;
    secureCookies?: boolean;
    /** When true, skip the requireUser preHandler so admin routes stay open (legacy tests). */
    skipGate?: boolean;
    /** CSRF allow-list. When set, every state-changing request must have a
     * matching Origin/Referer. Production startServer derives this from
     * PUBLIC_BASE_URL; tests pass ['http://localhost'] (or whatever they
     * use as a synthetic origin). When undefined, CSRF check is skipped. */
    allowedOrigins?: string[];
    /** Override the per-IP rate cap on /admin/auth/token-login. Default
     * is the route's own (5 per 5 minutes); the e2e runner raises it. */
    tokenLoginRateMax?: number;
  };
  /**
   * When set (and auth is wired), Google Drive picker integration routes
   * register. Tests can inject the exchange + driveFetcher to avoid hitting
   * Google. Production uses env vars.
   */
  gdrive?: {
    exchange?: DriveTokenExchange;
    driveFetcher?: typeof fetch;
  };
  /**
   * When set (and auth is wired), Microsoft OneDrive picker integration
   * registers. Same pattern as gdrive — tests inject stubs; production
   * derives wiring from MICROSOFT_CLIENT_ID / SECRET / TENANT env vars.
   */
  onedrive?: {
    exchange?: OneDriveTokenExchange;
    graphFetcher?: typeof fetch;
  };
}

export interface StartServerOpts {
  port?: number;
  host?: string;
  siteRoot?: string;
}

export async function buildApp(opts: BuildAppOpts = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    // Trust the loopback proxy (Apache, per deploy/apache.conf). Without
    // this, every `req.ip` resolves to 127.0.0.1 — which makes the
    // per-IP rate limit a single global bucket and turns sessions.ip
    // into useless forensic data. mod_proxy_http already adds
    // X-Forwarded-For by default (ProxyAddHeaders is on); we just
    // tell Fastify to honour it from the loopback hop only.
    trustProxy: 'loopback'
  });

  const siteRoot = opts.siteRoot ?? paths().root;

  await app.register(multipart, {
    limits: {
      fileSize: UPLOAD_LIMIT_BYTES,
      files: 1
    }
  });

  // Rate limiter: register globally with no default, individual routes
  // opt in via `config.rateLimit`. /img/:filename is gated to defend
  // against derivative-render DoS (sharp pipelines are expensive even
  // when they fail). Login start is gated against credential probing.
  await app.register(rateLimit, { global: false });

  app.get('/health', async () => {
    const gitHash = resolveGitHash();
    return {
      ok: true,
      gitHash,
      gitHashShort: gitHash === 'unknown' ? gitHash : gitHash.slice(0, 12)
    };
  });

  // Auth wiring (when db + auth opts are provided): register the
  // session-cookie middleware before admin routes so request.user is
  // populated, then register the auth flow routes.
  if (opts.db && opts.auth) {
    if (opts.auth.allowedOrigins && opts.auth.allowedOrigins.length > 0) {
      registerCsrfGuard(app, { allowedOrigins: opts.auth.allowedOrigins });
    }
    await registerAuthMiddleware(app, opts.db);
    await app.register(authRoutes, {
      db: opts.db,
      ...(opts.auth.exchange ? { exchange: opts.auth.exchange } : {}),
      ...(opts.auth.verifier ? { verifier: opts.auth.verifier } : {}),
      ...(opts.auth.tokenLoginRateMax !== undefined
        ? { tokenLoginRateMax: opts.auth.tokenLoginRateMax }
        : {}),
      secureCookies: opts.auth.secureCookies ?? true
    });
    // Picker integration routes (gated behind auth via requireUser).
    // Registers only when an exchange stub is supplied OR Google OAuth env
    // vars are set — otherwise we'd fail at registration trying to read
    // GOOGLE_CLIENT_ID. Skipping registration cleanly turns the routes
    // into 404s for unconfigured deployments.
    const gdriveConfigured =
      opts.gdrive?.exchange !== undefined ||
      (process.env.GOOGLE_CLIENT_ID &&
        process.env.GOOGLE_CLIENT_SECRET &&
        process.env.PUBLIC_BASE_URL);
    if (gdriveConfigured) {
      await app.register(integrationsGdriveRoutes, {
        db: opts.db,
        siteRoot,
        ...(opts.gdrive?.exchange ? { exchange: opts.gdrive.exchange } : {}),
        ...(opts.gdrive?.driveFetcher ? { driveFetcher: opts.gdrive.driveFetcher } : {}),
        secureCookies: opts.auth.secureCookies ?? true
      });
    }

    // OneDrive integration: same conditional-registration pattern as
    // gdrive. Production needs MICROSOFT_CLIENT_ID + SECRET +
    // PUBLIC_BASE_URL; tests inject opts.onedrive.exchange directly.
    const onedriveConfigured =
      opts.onedrive?.exchange !== undefined ||
      (process.env.MICROSOFT_CLIENT_ID &&
        process.env.MICROSOFT_CLIENT_SECRET &&
        process.env.PUBLIC_BASE_URL);
    if (onedriveConfigured) {
      await app.register(integrationsOnedriveRoutes, {
        db: opts.db,
        siteRoot,
        ...(opts.onedrive?.exchange ? { exchange: opts.onedrive.exchange } : {}),
        ...(opts.onedrive?.graphFetcher ? { graphFetcher: opts.onedrive.graphFetcher } : {}),
        secureCookies: opts.auth.secureCookies ?? true
      });
    }
  }

  await app.register(adminRoutes, {
    siteRoot,
    ...(opts.adminBundleDir !== undefined ? { adminBundleDir: opts.adminBundleDir } : {}),
    ...(opts.urlFetcher ? { urlFetcher: opts.urlFetcher } : {}),
    ...(opts.db ? { db: opts.db } : {}),
    requireAuth: !!(opts.db && opts.auth && !opts.auth.skipGate)
  });

  if (opts.db) {
    await app.register(publicRoutes, {
      siteRoot,
      db: opts.db,
      renderBudgetMs: opts.renderBudgetMs
    });

    if (opts.startWorker !== false) {
      // Concurrency = 1: one render at a time leaves CPU headroom
      // for live request handlers + Fastify itself. Pre-warm
      // (enqueued by /admin/posts on save) trickles through the
      // queue at a single image per slot rather than swamping the
      // single-machine deployment.
      const ctrl = workQueue({
        db: opts.db,
        ctx: { siteRoot },
        concurrency: 1
      });
      app.addHook('onClose', async () => {
        await ctrl.stop();
      });
    }
  }

  return app;
}

export async function startServer(opts: StartServerOpts = {}): Promise<FastifyInstance> {
  const cfg = serverConfig();
  const p = paths();
  const db = open(p.db);

  const publicBaseUrl = process.env.PUBLIC_BASE_URL;
  if (!publicBaseUrl) {
    throw new Error('PUBLIC_BASE_URL must be set (used for OAuth callback + CSRF allowlist)');
  }
  const app = await buildApp({
    logger: { level: cfg.logLevel },
    siteRoot: opts.siteRoot,
    db,
    auth: {
      secureCookies: true,
      allowedOrigins: [new URL(publicBaseUrl).origin]
    }
  });
  app.addHook('onClose', () => {
    db.close();
  });

  const port = opts.port ?? cfg.port;
  const host = opts.host ?? cfg.host;

  await app.listen({ port, host });
  app.log.info({ host, port }, 'rkr-blog listening');
  return app;
}
