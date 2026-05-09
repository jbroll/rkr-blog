# Notes for Claude

Project-specific guidance that supersedes default behavior.

## Be brief

User-visible text is a cost. Default to short.

- **End-of-turn summary**: 1-2 sentences. What changed, what's next.
  Don't restate the diff or reproduce work the user can already see.
- **Post-commit reviews** (triggered by the `git commit` PostToolUse
  hook): actually review the change. Look for regressions, missed
  edge cases, weak coverage, security/perf issues, deferred work
  surfaced by the diff.
  - Small items (typos, dead imports, comment polish, obvious
    refactors) — fix on the spot in a follow-up commit. Don't ask.
  - Substantive issues with more than one reasonable resolution —
    name the issue, list options with trade-offs, ask which to take.
  - Nothing material — confirm in one sentence and move on.
  - Skip multi-section recaps and diff narration; the user can see
    the diff.
- **No session-summary recaps** unless the user asks. Pushed commits
  are the record; a wall of bullets repeating them is noise.
- **Status lines while working**: one short sentence per real moment
  (found something, changed direction, hit a blocker). Silence is fine
  in between.
- **Match length to question**: a yes/no question gets a yes/no
  answer + one sentence of why if it isn't obvious.

## Code style

See `developer-quickstart.md §4` for the project's coding conventions
(ES modules, kebab-case filenames, no top-level side effects, etc.).

## Repo-specific

- The pre-commit hook (`.githooks/pre-commit`) runs the gauntlet:
  biome / tsc / duplicate-types / no-reexports / knip:gate / circular /
  size / c8 coverage. If it fails, fix the underlying issue — don't
  use `--no-verify` without a stated reason.
- Tests are exempt from the 500-line size cap; production source
  (`src/`, `bin/`) is not.
- `npm run setup` is the one-shot bootstrap (idempotent: npm install
  + chromium binary + git hooks). Use it after a fresh clone or when
  the Playwright cache is cleared.
- Deferred work goes in `DEFERRED.md`, not in commit messages or
  scattered TODOs. Each entry has Source / What / Why deferred /
  Trigger sections.
