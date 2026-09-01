// The four `site-admin` subcommands that test/cli/defaults-extended.test.ts
// left uncovered: export, import, wp-dump, server. Each is argv parsing and
// delegation over a lib function the lib's own tests already cover, so these
// pin the parsing, the exit-status contract, and the printed summary.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import exportCmd from '../../src/cli/export.ts';
import importCmd from '../../src/cli/import.ts';
import runServer from '../../src/cli/server.ts';
import wpDumpCmd from '../../src/cli/wp-dump.ts';
import { open } from '../../src/lib/db.ts';
import { migrate } from '../../src/lib/migrate.ts';

function withSiteRoot(t: TestContext, opts: { db?: boolean } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-cli-entry-'));
  for (const sub of ['sidecars', 'originals', 'cache/img', 'content/posts', 'data', 'config']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  if (opts.db !== false) {
    const db = open(path.join(root, 'data', 'site.db'));
    migrate(db);
    db.close();
  }
  const prev = process.env.SITE_ROOT;
  process.env.SITE_ROOT = root;
  t.after(() => {
    if (prev === undefined) delete process.env.SITE_ROOT;
    else process.env.SITE_ROOT = prev;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

// The commands report usage failures with process.exit(1) and keep going on
// the next line, so the stub has to stop execution the way a real exit would.
class Exited extends Error {
  code: number | undefined;
  constructor(code: number | undefined) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

interface Run {
  log: string[];
  err: string[];
  /** null when the command returned instead of exiting. */
  exit: number | null;
}

// Console capture and the exit stub have to live in one helper: an exiting
// command leaves the caller's `const { err } = await ...` unassigned.
async function run(t: TestContext, fn: () => void | Promise<void>): Promise<Run> {
  const log: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]): void => void log.push(a.map(String).join(' '));
  console.error = (...a: unknown[]): void => void err.push(a.map(String).join(' '));
  t.mock.method(process, 'exit', (code?: number) => {
    throw new Exited(code);
  });
  let exit: number | null = null;
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof Exited)) throw e;
    exit = e.code ?? 0;
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { log, err, exit };
}

// buildApp registers the Google OAuth route, which refuses to load without
// credentials; the values are never used because the route is never hit.
function withServerEnv(t: TestContext, extra: Record<string, string> = {}): void {
  withSiteRoot(t);
  const env: Record<string, string> = {
    PUBLIC_BASE_URL: 'http://127.0.0.1',
    LOG_LEVEL: 'silent',
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    ...extra
  };
  const prev = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const signalsBefore = {
    SIGTERM: process.listeners('SIGTERM').length,
    SIGINT: process.listeners('SIGINT').length
  };
  t.after(() => {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // startServer installs a shutdown handler per signal; drop the ones this
    // test added so the runner isn't left holding them.
    for (const sig of ['SIGTERM', 'SIGINT'] as const) {
      for (const l of process.listeners(sig).slice(signalsBefore[sig])) {
        process.removeListener(sig, l as () => void);
      }
    }
  });
}

describe('site-admin export', () => {
  it('writes an archive to the default dated filename', async (t) => {
    withSiteRoot(t);
    const cwd = process.cwd();
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-cli-out-'));
    process.chdir(out);
    t.after(() => {
      process.chdir(cwd);
      fs.rmSync(out, { recursive: true, force: true });
    });

    const { err } = await run(t, () => exportCmd([]));

    const written = fs.readdirSync(out);
    assert.equal(written.length, 1, `expected one archive, got ${written.join(', ')}`);
    assert.match(written[0] ?? '', /^rkr-blog-\d{4}-\d{2}-\d{2}\.sqlite$/);
    assert.match(err.join('\n'), /^exporting to /m);
    assert.match(err.join('\n'), /^done: \d+ files, \d+ comments, \d+ users, \d+ invites$/m);
  });

  it('honours --output and -o', async (t) => {
    const root = withSiteRoot(t);
    const dest = path.join(root, 'out', 'named.sqlite');
    await run(t, () => exportCmd(['--output', dest]));
    assert.ok(fs.existsSync(dest));

    const short = path.join(root, 'out', 'short.sqlite');
    await run(t, () => exportCmd(['-o', short]));
    assert.ok(fs.existsSync(short));
  });

  it('leaves no .tmp behind when the export fails', async (t) => {
    const root = withSiteRoot(t);
    const dest = path.join(root, 'out', 'archive.sqlite');
    fs.mkdirSync(dest, { recursive: true });
    await assert.rejects(run(t, () => exportCmd(['-o', dest])));
    assert.deepEqual(
      fs.readdirSync(path.join(root, 'out')).filter((f) => f.includes('.tmp')),
      []
    );
  });

  it('exits 1 when the database is missing', async (t) => {
    withSiteRoot(t, { db: false });
    const { err, exit } = await run(t, () => exportCmd([]));
    assert.equal(exit, 1);
    assert.match(err.join('\n'), /no database found/);
  });
});

describe('site-admin import', () => {
  it('round-trips an exported archive into a fresh site root', async (t) => {
    const source = withSiteRoot(t);
    fs.writeFileSync(
      path.join(source, 'content/posts/hello.md'),
      '---\ntitle: Hello\nslug: hello\n---\n\nbody\n'
    );
    const archive = path.join(source, 'archive.sqlite');
    await run(t, () => exportCmd(['-o', archive]));

    const dest = withSiteRoot(t);
    const { err } = await run(t, () => importCmd([archive]));

    assert.ok(fs.existsSync(path.join(dest, 'content/posts/hello.md')));
    assert.match(err.join('\n'), /^done: \d+ files written, \d+ skipped, /m);
  });

  it('warns before a --replace import, then refuses an ownerless archive', async (t) => {
    const source = withSiteRoot(t);
    const archive = path.join(source, 'archive.sqlite');
    await run(t, () => exportCmd(['-o', archive]));

    withSiteRoot(t);
    let thrown: unknown;
    const { err } = await run(t, () => {
      try {
        importCmd([archive, '--replace']);
      } catch (e) {
        thrown = e;
      }
    });

    // The warning goes out before importArchive runs, so the author is told
    // what --replace would have done even though the archive is refused.
    assert.match(err.join('\n'), /--replace will overwrite all files/);
    assert.match(String(thrown), /no owner-role user/);
  });

  it('rejects an unknown flag and a second archive argument', async (t) => {
    withSiteRoot(t);
    assert.throws(() => importCmd(['--nope']), /unknown flag: --nope/);
    assert.throws(
      () => importCmd(['a.sqlite', 'b.sqlite']),
      /unexpected extra argument: b\.sqlite/
    );
  });

  it('exits 1 with usage when given no archive', async (t) => {
    withSiteRoot(t);
    const { err, exit } = await run(t, () => importCmd([]));
    assert.equal(exit, 1);
    assert.match(err.join('\n'), /usage: site-admin import/);
  });

  it('exits 1 when the archive does not exist', async (t) => {
    withSiteRoot(t);
    const { err, exit } = await run(t, () => importCmd(['/nonexistent/archive.sqlite']));
    assert.equal(exit, 1);
    assert.match(err.join('\n'), /file not found/);
  });
});

describe('site-admin wp-dump', () => {
  const DUMP = `
DROP TABLE IF EXISTS \`wp_posts\`;
CREATE TABLE \`wp_posts\` (
  \`ID\` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  \`post_title\` text NOT NULL,
  PRIMARY KEY (\`ID\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT INTO \`wp_posts\` VALUES (1,'Hello');
`;

  it('converts a dump and reports what it wrote', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-cli-dump-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const sqlPath = path.join(dir, 'dump.sql');
    const dbPath = path.join(dir, 'out.db');
    fs.writeFileSync(sqlPath, DUMP);

    const { log } = await run(t, () => wpDumpCmd([sqlPath, dbPath]));

    assert.ok(fs.existsSync(dbPath));
    assert.equal(log.join('\n'), `1 tables, 1 rows → ${dbPath}`);
  });

  it('throws usage when either path is missing', async () => {
    await assert.rejects(wpDumpCmd([]), /usage: site-admin wp-dump/);
    await assert.rejects(wpDumpCmd(['dump.sql']), /usage: site-admin wp-dump/);
  });
});

describe('site-admin server', () => {
  it('listens on the --port it was given', async (t) => {
    withServerEnv(t);
    // Port 0 asks the OS for a free one, so the run can't collide with
    // anything else on the machine.
    const app = await runServer(['--port', '0']);
    t.after(() => app.close());

    const address = app.server.address();
    assert.ok(address && typeof address === 'object', 'server is not listening');
    assert.ok(address.port > 0);

    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 200);
  });

  it('falls back to the configured port with no --port', async (t) => {
    withServerEnv(t, { PORT: '0' });
    const app = await runServer([]);
    t.after(() => app.close());

    const address = app.server.address();
    assert.ok(address && typeof address === 'object', 'server is not listening');
    assert.ok(address.port > 0);
  });
});
