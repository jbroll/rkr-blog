#!/bin/sh
# Sourced by lefthook before every command (see `rc:` in lefthook.yml).
# Sets ORG_HOOKS so the scripts in profiles/sci-tiered.yml resolve.
export ORG_HOOKS=/home/john/src/org-hooks
# Per project policy (CLAUDE.md "Repo-specific"), tests are exempt from the
# line-size cap — only production src/ is capped (org default 500, via
# ts-size-cap). Raise the test cap out of the way; existing specs already run
# to ~3000 lines by design.
export TEST_SIZE_CAP=100000
# Pull org-wide hook env defaults (e.g. LEFTHOOK_OUTPUT — quiets passing
# commands so a failure isn't buried). Each default uses := — override any by
# exporting it BEFORE this line.
. "$ORG_HOOKS/rc.sh"
