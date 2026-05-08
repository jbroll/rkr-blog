// `site-admin reset` — call POST /admin/reset on a running rkroll-cms
// to wipe all post + image runtime data. Used to clean a demo before
// reseeding via `site-admin import-wp push`.
//
// Bearer-only on the server side: pass --token (or set ADMIN_TOKEN in
// env) so the call carries `Authorization: Bearer <token>`.
//
// Idempotent. Safe to re-run; the only side effect is "everything is
// gone, again."

interface CliOpts {
  toUrl: string;
  token: string;
  /** Skip the are-you-sure prompt. Default true since the operator
   * is the one driving the CLI; the prompt would only be useful for
   * accidental tab-completion. */
  force: boolean;
  fetcher: typeof fetch;
}

interface ResetResponse {
  ok: boolean;
  posts: number;
  originals: number;
  sidecars: number;
  cacheFiles: number;
  postsTableRows: number;
}

function parseArgs(argv: string[]): CliOpts {
  const toUrl = stringFlag(argv, '--to');
  if (!toUrl) {
    throw new Error('usage: site-admin reset --to <base-url> [--token TOKEN]');
  }
  const token = stringFlag(argv, '--token') ?? process.env.ADMIN_TOKEN;
  if (!token) {
    throw new Error(
      'bearer token required: pass --token <value> or set ADMIN_TOKEN in the environment'
    );
  }
  const force = argv.includes('--force') || argv.includes('-f');
  return { toUrl, token, force, fetcher: fetch };
}

function stringFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  return args[i + 1];
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** Exposed for tests so we can inject a fetcher bound to app.inject(). */
export async function runReset(opts: CliOpts): Promise<ResetResponse> {
  const url = `${stripTrailingSlash(opts.toUrl)}/admin/reset`;
  const res = await opts.fetcher(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${opts.token}` }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`reset failed: ${res.status} ${body}`);
  }
  return (await res.json()) as ResetResponse;
}

export default async function resetCmd(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  if (!opts.force) {
    // No interactive prompt — the operator passes --force or sees this
    // and re-runs. Cheap safeguard against an accidental copy/paste.
    console.error(
      'WARNING: this will permanently delete all posts, originals, sidecars,\n' +
        'and rendered derivatives on the target. Pass --force to proceed.'
    );
    process.exit(2);
  }

  console.log(`resetting ${opts.toUrl}...`);
  const result = await runReset(opts);
  console.log(
    `reset ok: posts=${result.posts}, originals=${result.originals}, sidecars=${result.sidecars}, cache=${result.cacheFiles} (db rows cleared: ${result.postsTableRows})`
  );
}
