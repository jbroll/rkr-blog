# Notes for Claude

Project-specific guidance that supersedes default behavior.

## Be brief

User-visible text is a cost. Default to short.

- **End-of-turn summary**: 1-2 sentences. What changed, what's next.
  Don't restate the diff or reproduce work the user can already see.
- **Post-commit reviews** — use judgment. Review before pushing
  for **clarity, conciseness, and security** when the commit is
  substantial: new behavior, auth/security/data-handling code,
  refactors that move logic, anything you'd want a second pair of
  eyes on. Skip review on trivial commits — doc edits, comment
  polish, single-line fixes, mechanical renames.
  - Simple, easy-to-fix issues (typos, dead imports, redundant code,
    missing clamps/escapes) — fix and amend into the current commit
    (`git add … && git commit --amend --no-edit`). The amend is
    explicitly authorised for this case; everywhere else, follow the
    default "create new commits" rule.
  - Serious issues with more than one reasonable resolution (design
    choices, real security concerns, missed edge cases) — present the
    alternatives to the user and wait for input. Don't silently pick.
  - For commits that warrant a fresh, independent read (auth touch,
    image-pipeline change, security-sensitive refactor), run
    `/review-step` rather than self-reviewing.
  - Skip diff narration; the user can see the diff.
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
