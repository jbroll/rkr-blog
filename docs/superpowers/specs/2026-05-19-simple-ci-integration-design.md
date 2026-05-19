# Simple-CI Integration Design

**Date:** 2026-05-19
**Status:** Draft

## Summary

Add simple-ci support so the pre-commit hook's slow e2e step auto-offloads to the `gpu` CI host when reachable, falling back to local execution when not. Mirrors the wicketmap pattern.

## Pieces

### `ci/simple-ci.conf`

Identical format to `~/src/wicketmap/ci/simple-ci.conf`. Probed in order by `sci`:

```bash
CI_HOSTS=(
    "gpu:http://gpu:8080"
    "home.rkroll.com:tunnel:8080"
)
CI_HOST=gpu
CI_REMOTE_SCRIPT=~/src/simple-ci/ci-rsync.sh
CI_SERVER_URL=http://gpu:8080
```

`sci` probes `CI_HOSTS` in order (direct HTTP, then SSH tunnel) and uses the first reachable host.

### `ci/test`

Runs on the CI server. No secrets needed — tests are self-contained.

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

npm install
npx playwright install chromium

npm run test:coverage                          # unit tests + c8

npm run build:admin
npm run build:site
node --no-warnings=ExperimentalWarning --experimental-strip-types \
  scripts/check-bundle-size.ts

npm run test:e2e

# Pass all admin+site TS files — CI always does a full check
admin_site_files=$(find src/admin src/site -name '*.ts' | tr '\n' ' ')
# shellcheck disable=SC2086
node --no-warnings=ExperimentalWarning --experimental-strip-types \
  scripts/check-e2e-coverage.ts $admin_site_files
```

### `sci host` command

New case in `~/bin/sci`. Loads conf, calls `resolve_ci_host`, prints `$CI_HOST` to stdout. Exits 1 if no host is reachable.

```bash
host)
    load_conf
    : "${CI_HOST:?no CI host reachable}"
    echo "$CI_HOST"
    ;;
```

Add `host` to the help text.

**Known limitation:** `sci host` probes independently of `sci push`. If the host was reachable for `sci push` but flakes before `sci host` runs, the scp step is skipped silently (baselines don't update locally, but the commit still lands since CI passed). This is acceptable.

### Pre-commit hook

Replace the `if [ -n "$admin_site_staged" ]` block with:

```bash
if [ -n "$admin_site_staged" ]; then
  _local_e2e() {
    echo "==> build admin+site bundles for e2e"
    npm run --silent build:admin > /dev/null
    npm run --silent build:site > /dev/null
    echo "==> bundle-size ratchet"
    node --no-warnings=ExperimentalWarning --experimental-strip-types \
      scripts/check-bundle-size.ts
    echo "==> e2e + V8 coverage"
    e2e_log=$(mktemp -t rkr-e2e-XXXXXX.log)
    if ! npm run --silent test:e2e -- --reporter=line > "$e2e_log" 2>&1; then
      echo "  -- e2e failed; last 60 lines of $e2e_log --"
      tail -60 "$e2e_log"
      exit 1
    fi
    rm -f "$e2e_log"
    echo "==> e2e coverage ratchet"
    node --no-warnings=ExperimentalWarning --experimental-strip-types \
      scripts/check-e2e-coverage.ts $admin_site_staged
  }

  ci_job_id=""
  if command -v sci > /dev/null 2>&1; then
    ci_job_id=$(sci push rkr-blog/ci/test 2>/dev/null) || ci_job_id=""
  fi

  if [ -n "$ci_job_id" ]; then
    echo "==> e2e offloaded to CI (job ${ci_job_id:0:8})"
    if ! sci wait "$ci_job_id"; then
      exit 1
    fi
    # scp ratchet baselines back so they travel with this commit
    if ci_host=$(sci host 2>/dev/null) && [ -n "$ci_host" ]; then
      worktree="ci-worktrees/rkr-blog-$ci_job_id"
      scp "$ci_host:$worktree/scripts/bundle-size-baseline.json" scripts/ 2>/dev/null || true
      scp "$ci_host:$worktree/scripts/coverage-baseline.json" scripts/ 2>/dev/null || true
      git add scripts/bundle-size-baseline.json scripts/coverage-baseline.json 2>/dev/null || true
    fi
  else
    _local_e2e
  fi
fi
```

## Execution flow

```
git commit (admin/site files staged)
  └─ sci available + gpu reachable?
       ├─ YES → sci push rkr-blog/ci/test  (rsync + queue)
       │         sci wait <id>              (streams log, exits 0/1)
       │         sci host → scp baselines back + git add
       └─ NO  → local: build → bundle ratchet → e2e → coverage ratchet
```

## Files changed

| File | Change |
|------|--------|
| `ci/simple-ci.conf` | **Create** |
| `ci/test` | **Create** |
| `~/bin/sci` | **Modify** — add `host` command |
| `.githooks/pre-commit` | **Modify** — auto-offload when CI reachable |
