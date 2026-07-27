import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const HOOK = path.join(REPO, 'deploy/hooks/fastify_app.build.post.sh');

/** A throwaway git repo so `git -C "$PROJECT_DIR" rev-parse HEAD` succeeds. */
function makeGitProjectDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fastify-hook-project-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README'), 'x');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

/**
 * Run the real hook the way a real build does: a project dir with the site
 * env and secrets files on disk, and $TMP_DIR/app pre-seeded with
 * secrets.env the way node_app/build.sh (which runs first) would have left
 * it — a copy of $FASTIFY_APP_SECRETS_FILE, or absent if that file didn't
 * exist. Returns { tmp, projectDir } so callers can inspect the merged file.
 */
function runHook(opts: {
  appName?: string;
  dataPath?: string;
  siteEnvContents: string;
  secretsFileContents?: string; // undefined = secrets file does not exist on disk
  preSeedSecretsEnv?: boolean; // mimic node_app/build.sh having already copied it
}): { tmp: string; projectDir: string; run: () => string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fastify-hook-'));
  fs.mkdirSync(path.join(tmp, 'app'), { recursive: true });
  const projectDir = makeGitProjectDir();

  const siteEnvRel = 'deploy/sites/test-site.env';
  fs.mkdirSync(path.join(projectDir, 'deploy/sites'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, siteEnvRel), opts.siteEnvContents);

  const secretsRel = 'deploy/secrets/test-site.secrets.env';
  if (opts.secretsFileContents !== undefined) {
    fs.mkdirSync(path.join(projectDir, 'deploy/secrets'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, secretsRel), opts.secretsFileContents);
    if (opts.preSeedSecretsEnv ?? true) {
      fs.writeFileSync(path.join(tmp, 'app/secrets.env'), opts.secretsFileContents);
    }
  }

  const env = {
    PATH: process.env.PATH ?? '',
    TMP_DIR: tmp,
    PROJECT_DIR: projectDir,
    APP_NAME: opts.appName ?? 'rkr-blog',
    FASTIFY_APP_DATA_PATH: opts.dataPath ?? '/var/www',
    SITE_ENV_FILE: siteEnvRel,
    FASTIFY_APP_SECRETS_FILE: secretsRel
  };

  return {
    tmp,
    projectDir,
    run: () => execFileSync('bash', [HOOK], { env, encoding: 'utf8' })
  };
}

function stderrOf(err: unknown): string {
  return (err as { stderr?: string })?.stderr ?? '';
}

test('hook fails the build when FASTIFY_APP_SECRETS_FILE does not exist on disk', () => {
  const { run } = runHook({
    siteEnvContents: 'SITE_ROOT=/var/www/rkr-blog\n',
    secretsFileContents: undefined
  });
  assert.throws(
    () => run(),
    (err: unknown) => /missing secrets file/.test(stderrOf(err))
  );
});

test('hook rejects a merged secrets.env whose effective SITE_ROOT does not match APP_NAME', () => {
  // Reproduces the shipped bug: the secrets file (last-wins, like systemd's
  // EnvironmentFile) carries a stale SITE_ROOT that overrides the value the
  // apache-hook guard already approved in the site env file.
  const { run } = runHook({
    siteEnvContents: 'SITE_ROOT=/var/www/rkr-blog\n',
    secretsFileContents: 'ADMIN_TOKEN=x\nSITE_ROOT=/var/www/wrong-name\n'
  });
  assert.throws(
    () => run(),
    (err: unknown) => /effective SITE_ROOT/.test(stderrOf(err)) && /wrong-name/.test(stderrOf(err))
  );
});

test('hook rejects a merged secrets.env with no SITE_ROOT line at all', () => {
  const { run } = runHook({
    siteEnvContents: 'PUBLIC_BASE_URL=https://rkr-blog.rkroll.com\n',
    secretsFileContents: 'ADMIN_TOKEN=x\n'
  });
  assert.throws(
    () => run(),
    (err: unknown) => /has no SITE_ROOT= line/.test(stderrOf(err))
  );
});

test('hook accepts a merged secrets.env whose effective SITE_ROOT matches APP_NAME (fails later, at the PWA build, not at the guard)', () => {
  // A real project tree isn't set up here, so the hook still fails overall
  // (no apps/image-pwa workspace) — the point of this test is that it gets
  // PAST our SITE_ROOT guard first, proving a correct config isn't rejected.
  const { run } = runHook({
    siteEnvContents: 'SITE_ROOT=/var/www/rkr-blog\n',
    secretsFileContents: 'ADMIN_TOKEN=x\n'
  });
  assert.throws(
    () => run(),
    (err: unknown) => {
      const stderr = stderrOf(err);
      return !/SITE_ROOT/.test(stderr) && !/missing secrets file/.test(stderr);
    }
  );
});
