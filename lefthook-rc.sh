#!/bin/sh
# Sourced by lefthook before every command (see `rc:` in lefthook.yml).
# Sets ORG_HOOKS so the scripts in profiles/sci-tiered.yml resolve.
export ORG_HOOKS=/home/john/src/org-hooks
# Pull org-wide hook env defaults (e.g. LEFTHOOK_OUTPUT — quiets passing
# commands so a failure isn't buried). Each default uses := — override any by
# exporting it BEFORE this line.
. "$ORG_HOOKS/rc.sh"
