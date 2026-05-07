---
name: review-step
description: Independent code review of the most recent commit (or a specified commit) and adjacent code. Spawns a fresh general-purpose agent that reads the diff, surrounding files, and tests, and reports findings prioritized as Must-fix / Should-fix / Consider / Strengths. Use after each step in spec §21 build order, before moving on.
---

# review-step

Run an independent code review of recently-committed work. Designed for the rkroll-cms build flow where each step lands as a single fast-forwarded commit on `main`. The PostToolUse hook in `.claude/settings.json` reminds Claude to consider invoking this after each `git commit`.

## What it does

1. Resolves the target commit:
   - No argument → `HEAD` (the most recent commit)
   - One arg starting with a digit → that many commits back, e.g. `HEAD~N`
   - Otherwise → treated as a git ref/SHA
2. Captures the commit message, diff, and lists adjacent files (same directories as the touched files)
3. Spawns a fresh `general-purpose` agent with that material
4. Reports findings inline in the conversation

## Scope of the review

- **Correctness** — bugs, edge cases, off-by-ones, missing cleanup
- **Project conventions** — CLAUDE.md / spec.md style, Biome lint, no premature abstraction, "no comments unless WHY is non-obvious"
- **Tests** — meaningful behavioral coverage gaps (not raw line coverage)
- **Security adjacency** — any escape, validation, auth, or boundary-relevant change should be checked against the recent security audit's findings
- **Adjacent code** — same file beyond the diff, sibling files, callers/callees that might need updating

## How to invoke

```
/review-step              # review HEAD
/review-step 1            # review HEAD~1 (the previous commit)
/review-step <sha>        # review a specific commit
```

When invoked, do the following:

1. Run `git log -1 --format=%H%n%s%n%n%b ${ARGUMENTS:-HEAD}` to capture the commit subject + body. Bail with a clear message if the ref doesn't resolve.

2. Run `git diff ${ARGUMENTS:-HEAD}^..${ARGUMENTS:-HEAD}` to capture the diff.

3. Run `git diff --name-only ${ARGUMENTS:-HEAD}^..${ARGUMENTS:-HEAD}` to list touched files. From those, derive the set of unique parent directories — the agent will list adjacent files there.

4. Spawn a `general-purpose` agent (foreground) with this self-contained brief:

   - Repository root: /home/user/rkr-blog
   - Target commit: `<sha + subject>`
   - Commit message body: `<body>`
   - Diff: paste the diff inline (truncate any single hunk over 200 lines and note the truncation)
   - Touched files: list
   - Adjacent files in the same directories: list (the agent should `ls` each parent dir)
   - Spec context: `/home/user/rkr-blog/spec.md` is the design spec; `/home/user/rkr-blog/CLAUDE.md` may exist with project conventions

   Ask the agent for a report under 700 words structured as:
   - **Overall assessment** (1 paragraph)
   - **Must-fix** (real bugs / correctness issues)
   - **Should-fix** (convention / quality issues worth addressing before next step)
   - **Consider** (judgment-call refactors / discussion points)
   - **Strengths** (1–2 sentences)

   Tell the agent to cite `file:line` for every concrete finding and to skip filler praise.

5. When the agent returns, render its report verbatim to the user as the assistant message. Do not summarize — the user wants the full review. End with one line listing immediate next-step suggestions (apply Must-fix, defer the rest, or move on).

## Notes

- This skill does NOT modify code on its own. It returns findings; the user decides what to act on.
- Don't run this on a commit that's still on a feature branch waiting for review — spawn the user-invoked `/review` for PR-level review instead. `/review-step` is for the post-commit, pre-next-step pause.
- If the diff is enormous (>1000 changed lines), warn the user and offer to review the most recent commit only, or to break it into chunks by file.
