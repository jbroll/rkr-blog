import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { resolveGitHashIn } from '../../src/lib/build-info.ts';

const SHA = 'a'.repeat(40);

function tmp(t: TestContext): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rkr-gitdir-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test('plain .git dir, HEAD points at a loose ref', (t) => {
  const root = tmp(t);
  const gitDir = path.join(root, '.git');
  fs.mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(gitDir, 'refs', 'heads', 'main'), `${SHA}\n`);
  assert.equal(resolveGitHashIn(gitDir), SHA);
});

test('plain .git dir, detached HEAD is a raw SHA', (t) => {
  const root = tmp(t);
  const gitDir = path.join(root, '.git');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'HEAD'), `${SHA}\n`);
  assert.equal(resolveGitHashIn(gitDir), SHA);
});

test('gitlink file: ref lives in the shared common dir (worktree layout)', (t) => {
  const root = tmp(t);
  // Common repo dir with the loose branch ref.
  const common = path.join(root, '.git');
  fs.mkdirSync(path.join(common, 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(common, 'refs', 'heads', 'feat'), `${SHA}\n`);
  // Per-worktree gitdir: HEAD here, ref resolved via commondir.
  const wt = path.join(common, 'worktrees', 'feat');
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, 'HEAD'), 'ref: refs/heads/feat\n');
  fs.writeFileSync(path.join(wt, 'commondir'), '../..\n');
  // The checkout's `.git` is a gitlink file pointing at the worktree dir.
  const gitlink = path.join(root, 'checkout', '.git');
  fs.mkdirSync(path.dirname(gitlink), { recursive: true });
  fs.writeFileSync(gitlink, `gitdir: ${wt}\n`);
  assert.equal(resolveGitHashIn(gitlink), SHA);
});

test('gitlink file: ref present in the per-worktree dir', (t) => {
  const root = tmp(t);
  const wt = path.join(root, 'wt');
  fs.mkdirSync(path.join(wt, 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'HEAD'), 'ref: refs/heads/x\n');
  fs.writeFileSync(path.join(wt, 'refs', 'heads', 'x'), `${SHA}\n`);
  fs.writeFileSync(path.join(wt, 'commondir'), '.\n');
  const gitlink = path.join(root, '.git');
  fs.writeFileSync(gitlink, `gitdir: ${wt}\n`);
  assert.equal(resolveGitHashIn(gitlink), SHA);
});

test('garbage gitlink / missing HEAD → null', (t) => {
  const root = tmp(t);
  const gitlink = path.join(root, '.git');
  fs.writeFileSync(gitlink, 'not a gitdir line\n');
  assert.equal(resolveGitHashIn(gitlink), null);
});
