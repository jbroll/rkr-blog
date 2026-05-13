// Surface tests for the CLI default exports that test/cli/defaults.test.ts
// didn't already cover: init, migrate, user, jobs, reset, import-wp.
//
// Like the existing file: drive each CLI's default export with a
// crafted argv against a temp $SITE_ROOT, assert on stdout / thrown
// errors. The underlying logic is already tested via src/lib/*; this
// pins the argv parsing + exit-status contract that the bin/site-admin
// shim depends on.
//
// server.ts is intentionally not covered here — its default export
// boots a Fastify listener and would leave a process around.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

function withSiteRoot(t: TestContext): { root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-cli-ext-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'content/posts', 'data']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  const prev = process.env.SITE_ROOT;
  process.env.SITE_ROOT = root;
  t.after(() => {
    if (prev === undefined) delete process.env.SITE_ROOT;
    else process.env.SITE_ROOT = prev;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root };
}

/** Capture console.log + console.error output for the duration of
 * `fn`. Returns the captured lines. */
async function captureLogs(
  fn: () => void | Promise<void>
): Promise<{ log: string[]; err: string[] }> {
  const log: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]): void => {
    log.push(args.map((a) => String(a)).join(' '));
  };
  console.error = (...args: unknown[]): void => {
    err.push(args.map((a) => String(a)).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { log, err };
}

// ---- init ---------------------------------------------------------

test('init default export: creates SITE_ROOT subdirs + opens db + prints summary', async (t) => {
  const { root } = withSiteRoot(t);
  // Wipe a subset so init has dirs to create.
  fs.rmSync(path.join(root, 'originals'), { recursive: true, force: true });
  const initCmd = (await import('../../src/cli/init.ts')).default;
  const { log } = await captureLogs(() => initCmd());
  assert.match(log[0] ?? '', /^init complete: /);
  // First run generates the secret key.
  assert.match(log[0] ?? '', /generated data\/secret\.key/);
  for (const sub of ['originals', 'sidecars', 'cache/img', 'content/posts', 'data']) {
    assert.ok(fs.existsSync(path.join(root, sub)), `${sub} missing post-init`);
  }
  // Migrations applied → site.db exists.
  assert.ok(fs.existsSync(path.join(root, 'data', 'site.db')));
});

test('init default export: second run reports no-op + omits key-generated suffix', async (t) => {
  withSiteRoot(t);
  const initCmd = (await import('../../src/cli/init.ts')).default;
  await captureLogs(() => initCmd()); // first run primes everything
  const { log } = await captureLogs(() => initCmd()); // second is a no-op
  assert.match(log[0] ?? '', /^init complete: /);
  assert.match(log[0] ?? '', /no migrations to apply/);
  // Key already exists → no "generated data/secret.key" suffix.
  assert.ok(!log[0]?.includes('generated data/secret.key'));
});

// ---- migrate ------------------------------------------------------

test('migrate default export: applies migrations + prints summary on first run', async (t) => {
  withSiteRoot(t);
  const migrateCmd = (await import('../../src/cli/migrate.ts')).default;
  const { log } = await captureLogs(() => migrateCmd());
  // Either applied N migrations OR (in case prior tests ran in same
  // process) reports nothing to apply. Both shapes start with
  // 'migrate:'.
  assert.match(log[0] ?? '', /^migrate: /);
});

test('migrate default export: second run reports "nothing to apply"', async (t) => {
  withSiteRoot(t);
  const migrateCmd = (await import('../../src/cli/migrate.ts')).default;
  await captureLogs(() => migrateCmd()); // first run applies
  const { log } = await captureLogs(() => migrateCmd()); // second is a no-op
  assert.match(log[0] ?? '', /nothing to apply|database up to date/);
});

// ---- user ---------------------------------------------------------

test('user default export: invite + list + remove cycle', async (t) => {
  withSiteRoot(t);
  const userCmd = (await import('../../src/cli/user.ts')).default;

  const inv = await captureLogs(() => userCmd(['invite', 'alice@example.com']));
  assert.match(inv.log.join('\n'), /invited alice@example.com as editor/);

  const list1 = await captureLogs(() => userCmd(['list']));
  assert.match(list1.log.join('\n'), /alice@example.com/);

  const rm = await captureLogs(() => userCmd(['remove', 'alice@example.com']));
  assert.match(rm.log.join('\n'), /removed invite alice@example.com/);

  const list2 = await captureLogs(() => userCmd(['list']));
  // After removal, no invite line for alice. (User row never existed
  // since she never signed in — removeInvite is sufficient.)
  assert.ok(!list2.log.join('\n').includes('alice@example.com'));
});

test('user default export: --role owner accepted', async (t) => {
  withSiteRoot(t);
  const userCmd = (await import('../../src/cli/user.ts')).default;
  const { log } = await captureLogs(() =>
    userCmd(['invite', 'bob@example.com', '--role', 'owner'])
  );
  assert.match(log.join('\n'), /invited bob@example.com as owner/);
});

test('user default export: rejects unknown subcommand', async (t) => {
  withSiteRoot(t);
  const userCmd = (await import('../../src/cli/user.ts')).default;
  await assert.rejects(userCmd(['bogus']), /usage: site-admin user/);
});

test('user default export: rejects invalid role', async (t) => {
  withSiteRoot(t);
  const userCmd = (await import('../../src/cli/user.ts')).default;
  await assert.rejects(
    userCmd(['invite', 'c@example.com', '--role', 'admin']),
    /role must be one of owner\|editor/
  );
});

test('user default export: invite without email throws usage', async (t) => {
  withSiteRoot(t);
  const userCmd = (await import('../../src/cli/user.ts')).default;
  await assert.rejects(userCmd(['invite']), /usage: site-admin user invite/);
});

test('user default export: remove without email throws usage', async (t) => {
  withSiteRoot(t);
  const userCmd = (await import('../../src/cli/user.ts')).default;
  await assert.rejects(userCmd(['remove']), /usage: site-admin user remove/);
});

test('user default export: remove of unknown email reports "no invite found"', async (t) => {
  withSiteRoot(t);
  const userCmd = (await import('../../src/cli/user.ts')).default;
  const { log } = await captureLogs(() => userCmd(['remove', 'nope@example.com']));
  assert.match(log.join('\n'), /no invite found for nope@example.com/);
});

// ---- jobs ---------------------------------------------------------

test('jobs default export: unknown subcommand throws usage', async (t) => {
  withSiteRoot(t);
  const jobsCmd = (await import('../../src/cli/jobs.ts')).default;
  await assert.rejects(jobsCmd([]), /usage: site-admin jobs failed/);
  await assert.rejects(jobsCmd(['bogus']), /usage: site-admin jobs failed/);
});

test('jobs default export: missing jobs table surfaces a SQLite error', async (t) => {
  // No migrate → no schema. `jobs failed` opens the DB lazily and
  // hits a SQLITE error on the first query. We don't promise a
  // pretty message here, just that the failure surfaces as a thrown
  // Error rather than a silent zero-exit.
  withSiteRoot(t);
  const jobsCmd = (await import('../../src/cli/jobs.ts')).default;
  await assert.rejects(jobsCmd(['failed']));
});

test('jobs default export: empty queue reports "no failed jobs"', async (t) => {
  const { root } = withSiteRoot(t);
  // jobs CLI needs the schema; run migrate first.
  const migrateCmd = (await import('../../src/cli/migrate.ts')).default;
  await captureLogs(() => migrateCmd());
  // Sanity: the migration created the jobs table.
  assert.ok(fs.existsSync(path.join(root, 'data', 'site.db')));

  const jobsCmd = (await import('../../src/cli/jobs.ts')).default;
  const { log } = await captureLogs(() => jobsCmd(['failed']));
  assert.match(log.join('\n'), /^no failed jobs/);
});

test('jobs default export: lists pre-seeded failed jobs', async (t) => {
  const { root } = withSiteRoot(t);
  const migrateCmd = (await import('../../src/cli/migrate.ts')).default;
  await captureLogs(() => migrateCmd());
  // Seed a failed job directly.
  const { open } = await import('../../src/lib/db.ts');
  const db = open(path.join(root, 'data', 'site.db'));
  db.prepare(
    "INSERT INTO jobs (kind, payload, state, attempts, error, cache_key, created_at, updated_at) VALUES ('render', '{}', 'failed', 3, 'sharp: boom', 'abc12345', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
  ).run();
  // Second row with NULL error + NULL cache_key exercises the
  // nullish-coalesce + falsy-errLine branches in the print loop.
  db.prepare(
    "INSERT INTO jobs (kind, payload, state, attempts, error, cache_key, created_at, updated_at) VALUES ('gc', '{}', 'failed', 1, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
  ).run();
  db.close();

  const jobsCmd = (await import('../../src/cli/jobs.ts')).default;
  const { log } = await captureLogs(() => jobsCmd(['failed']));
  const out = log.join('\n');
  assert.match(out, /2 failed job/);
  assert.match(out, /render attempts=3/);
  assert.match(out, /error: sharp: boom/);
  // Second row: kind=gc, no error line printed, cache_key falls back to '-'.
  assert.match(out, /gc attempts=1.*cache_key=-/);
});

// ---- reset --------------------------------------------------------

test('reset default export: rejects missing --to', async (t) => {
  withSiteRoot(t);
  const resetCmd = (await import('../../src/cli/reset.ts')).default;
  await assert.rejects(resetCmd([]), /usage: site-admin reset --to/);
});

test('reset default export: rejects missing --token (and no ADMIN_TOKEN env)', async (t) => {
  withSiteRoot(t);
  const prev = process.env.ADMIN_TOKEN;
  delete process.env.ADMIN_TOKEN;
  t.after(() => {
    if (prev === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = prev;
  });
  const resetCmd = (await import('../../src/cli/reset.ts')).default;
  await assert.rejects(resetCmd(['--to', 'http://x']), /bearer token required/);
});

test('reset runReset: posts to /admin/reset with bearer header', async (t) => {
  withSiteRoot(t);
  const { runReset } = await import('../../src/cli/reset.ts');
  // Stub fetcher captures the request shape; returns a fake success
  // body so runReset's happy path completes.
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const stub: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(
      JSON.stringify({
        ok: true,
        posts: 3,
        originals: 5,
        sidecars: 5,
        cacheFiles: 12,
        postsTableRows: 3
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };
  const result = await runReset({
    toUrl: 'https://example.test',
    token: 'secret-token-123',
    force: true,
    fetcher: stub
  });
  assert.equal(capturedUrl, 'https://example.test/admin/reset');
  assert.equal(capturedInit?.method, 'POST');
  const headers = capturedInit?.headers as Record<string, string> | undefined;
  assert.equal(headers?.authorization, 'Bearer secret-token-123');
  assert.equal(result.posts, 3);
  assert.equal(result.originals, 5);
});

test('reset runReset: non-2xx response surfaces as error', async (t) => {
  withSiteRoot(t);
  const { runReset } = await import('../../src/cli/reset.ts');
  const stub: typeof fetch = async () => new Response('invalid token', { status: 401 });
  await assert.rejects(
    () =>
      runReset({
        toUrl: 'https://example.test',
        token: 'wrong-token',
        force: true,
        fetcher: stub
      }),
    /reset failed: 401/
  );
});

// ---- import-wp ----------------------------------------------------

test('import-wp default export: no subcommand throws usage', async (t) => {
  withSiteRoot(t);
  const cmd = (await import('../../src/cli/import-wp.ts')).default;
  await assert.rejects(cmd([]), /usage:/);
});

test('import-wp default export: list without base-url throws', async (t) => {
  withSiteRoot(t);
  const cmd = (await import('../../src/cli/import-wp.ts')).default;
  await assert.rejects(cmd(['list']), /<base-url>/);
});

test('import-wp default export: post without id throws', async (t) => {
  withSiteRoot(t);
  const cmd = (await import('../../src/cli/import-wp.ts')).default;
  await assert.rejects(cmd(['post', 'http://wp.example.com']), /<id-or-slug>/);
});

test('import-wp default export: push without slug throws', async (t) => {
  withSiteRoot(t);
  const cmd = (await import('../../src/cli/import-wp.ts')).default;
  await assert.rejects(cmd(['push', 'http://wp.example.com']), /usage:/);
});

test('import-wp default export: push without --to throws', async (t) => {
  withSiteRoot(t);
  const cmd = (await import('../../src/cli/import-wp.ts')).default;
  await assert.rejects(cmd(['push', 'http://wp.example.com', 'my-slug']), /--to <fly-url>/);
});

test('import-wp default export: push without token throws', async (t) => {
  withSiteRoot(t);
  const prev = process.env.ADMIN_TOKEN;
  delete process.env.ADMIN_TOKEN;
  t.after(() => {
    if (prev === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = prev;
  });
  const cmd = (await import('../../src/cli/import-wp.ts')).default;
  await assert.rejects(
    cmd(['push', 'http://wp.example.com', 'my-slug', '--to', 'http://fly.example.com']),
    /bearer token required/
  );
});

test('import-wp default export: list rejects non-numeric --page', async (t) => {
  withSiteRoot(t);
  const cmd = (await import('../../src/cli/import-wp.ts')).default;
  await assert.rejects(cmd(['list', 'http://wp.example.com', '--page', 'abc']), /numeric value/);
});
