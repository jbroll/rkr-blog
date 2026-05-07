// Fastify app factory. Exports buildApp() so tests can drive the server
// without binding a port, and startServer() for the bin entry point.

import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import Fastify from 'fastify';
import { registerAuthMiddleware } from './lib/auth-middleware.ts';
import { paths, serverConfig } from './lib/config.ts';
import { type Db, open } from './lib/db.ts';
import type { IdTokenVerifier } from './lib/google-jwt.ts';
import { workQueue } from './lib/jobs.ts';
import adminRoutes, { type UrlFetcher } from './routes/admin.ts';
import authRoutes, { type TokenExchange } from './routes/auth.ts';
import integrationsGdriveRoutes, { type DriveTokenExchange } from './routes/integrations-gdrive.ts';
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
}

export interface StartServerOpts {
  port?: number;
  host?: string;
  siteRoot?: string;
}

export async function buildApp(opts: BuildAppOpts = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false
  });

  const siteRoot = opts.siteRoot ?? paths().root;

  await app.register(multipart, {
    limits: {
      fileSize: UPLOAD_LIMIT_BYTES,
      files: 1
    }
  });

  app.get('/health', async () => ({ ok: true }));

  // Auth wiring (when db + auth opts are provided): register the
  // session-cookie middleware before admin routes so request.user is
  // populated, then register the auth flow routes.
  if (opts.db && opts.auth) {
    await registerAuthMiddleware(app, opts.db);
    await app.register(authRoutes, {
      db: opts.db,
      ...(opts.auth.exchange ? { exchange: opts.auth.exchange } : {}),
      ...(opts.auth.verifier ? { verifier: opts.auth.verifier } : {}),
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
  }

  await app.register(adminRoutes, {
    siteRoot,
    ...(opts.adminBundleDir !== undefined ? { adminBundleDir: opts.adminBundleDir } : {}),
    ...(opts.urlFetcher ? { urlFetcher: opts.urlFetcher } : {}),
    requireAuth: !!(opts.db && opts.auth && !opts.auth.skipGate)
  });

  if (opts.db) {
    await app.register(publicRoutes, {
      siteRoot,
      db: opts.db,
      renderBudgetMs: opts.renderBudgetMs
    });

    if (opts.startWorker !== false) {
      const ctrl = workQueue({
        db: opts.db,
        ctx: { siteRoot }
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

  const app = await buildApp({
    logger: { level: cfg.logLevel },
    siteRoot: opts.siteRoot,
    db,
    auth: { secureCookies: true }
  });
  app.addHook('onClose', () => {
    db.close();
  });

  const port = opts.port ?? cfg.port;
  const host = opts.host ?? cfg.host;

  await app.listen({ port, host });
  console.log(`rkroll-cms listening on http://${host}:${port}`);
  return app;
}
