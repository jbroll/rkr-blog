// Resolve the build's git commit SHA so /health can show what's deployed.
//
// Resolution order (first hit wins):
//   1. GIT_HASH env var          — runtime override (CI overrides, local probes)
//   2. file at GIT_HASH_FILE     — explicit file path override
//   3. git-hash file near module — deploy hook writes <app-root>/git-hash at build time
//   4. .git/HEAD (chasing refs)  — local dev with a git checkout
//   5. 'unknown'                 — gracefully degrade rather than crash /health
//
// Resolved once per process and cached. The handler reads the cached
// value; calling resolveGitHash() again returns the same string.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | undefined;

const SHA_RE = /^[0-9a-f]{7,40}$/;

export function resolveGitHash(): string {
  if (cached !== undefined) return cached;
  cached = resolveUncached();
  return cached;
}

/** Test-only: clear the cache so the next call re-resolves. */
export function _resetGitHashCache(): void {
  cached = undefined;
}

function resolveUncached(): string {
  const fromEnv = process.env.GIT_HASH;
  if (fromEnv && SHA_RE.test(fromEnv)) return fromEnv;

  const fromFile = readHashFile(process.env.GIT_HASH_FILE);
  if (fromFile) return fromFile;

  const fromNearModule = readHashNearModule();
  if (fromNearModule) return fromNearModule;

  const fromGitDir = readFromGitDir();
  if (fromGitDir) return fromGitDir;

  /* c8 ignore next -- only reachable outside a git checkout */
  return 'unknown';
}

function readHashFile(file: string | undefined): string | null {
  if (!file) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    return SHA_RE.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Walk up from this module's directory looking for a `git-hash` file
 * written by the deploy hook. Finds e.g. /opt/rkr-blog/git-hash when
 * the module lives at /opt/rkr-blog/src/lib/build-info.ts. */
function readHashNearModule(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, 'git-hash');
    const hash = readHashFile(candidate);
    if (hash) return hash;
    const parent = path.dirname(dir);
    /* c8 ignore next -- only reachable at filesystem root */
    if (parent === dir) return null;
    dir = parent;
  }
  /* c8 ignore next -- only reachable outside a git checkout */
  return null;
}

/** Walk up from this module's directory to find a .git dir, then resolve
 * HEAD → refs/heads/<branch> → SHA. Returns null if anything's amiss
 * (detached HEAD with a non-ref pointer is handled — HEAD itself can
 * already be a SHA). */
function readFromGitDir(): string | null {
  // __dirname equivalent under ESM. import.meta.url resolves at runtime.
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, '.git');
    if (fs.existsSync(candidate)) {
      return resolveGitHashIn(candidate);
    }
    const parent = path.dirname(dir);
    /* c8 ignore next -- only reachable at filesystem root */
    if (parent === dir) return null;
    dir = parent;
  }
  /* c8 ignore next -- only reachable outside a git checkout */
  return null;
}

/** Resolve a SHA from a `.git` location. `gitPath` is a directory in a
 * normal checkout, or a gitlink file (`gitdir: <path>`) in a linked
 * worktree / submodule. In a linked worktree HEAD lives in the
 * per-worktree gitdir but branch refs live in the shared common dir
 * (located via the `commondir` file), so a `ref:` HEAD is resolved
 * against the worktree dir first, then the common dir. Packed refs are
 * not consulted (parity with the original loose-ref-only behaviour).
 * Exported for tests; production reaches it via readFromGitDir(). */
export function resolveGitHashIn(gitPath: string): string | null {
  try {
    let gitDir = gitPath;
    if (fs.statSync(gitPath).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitPath, 'utf8'));
      if (!m?.[1]) return null;
      gitDir = path.resolve(path.dirname(gitPath), m[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    // HEAD is either `ref: refs/heads/<branch>` or a raw SHA (detached).
    if (SHA_RE.test(head)) return head;
    const refMatch = /^ref:\s+(.+)$/.exec(head);
    if (!refMatch?.[1]) return null;
    const ref = refMatch[1];
    const fromWorktree = readRefFile(path.join(gitDir, ref));
    if (fromWorktree) return fromWorktree;
    const commonDirFile = path.join(gitDir, 'commondir');
    if (!fs.existsSync(commonDirFile)) return null;
    const commonDir = path.resolve(gitDir, fs.readFileSync(commonDirFile, 'utf8').trim());
    return readRefFile(path.join(commonDir, ref));
  } catch {
    return null;
  }
}

function readRefFile(refPath: string): string | null {
  try {
    const sha = fs.readFileSync(refPath, 'utf8').trim();
    return SHA_RE.test(sha) ? sha : null;
  } catch {
    return null;
  }
}
