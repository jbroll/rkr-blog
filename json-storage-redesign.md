# JSON Storage Redesign

Replace markdown-on-disk with TipTap (ProseMirror) JSON as the canonical
post format. Keep the existing outbox + LWW sync model from
`spec-offline.md`. **Do not** introduce Yjs.

## Goal

Eliminate the lossy round-trip `editor.getJSON() → markdown string →
remark AST → HTML`. Custom nodes (currently `FigureNode`, future
others) stop needing bespoke directive serializers/parsers. One renderer
runs in both the browser preview and the server render path.

## Non-goals

- **No CRDT / Yjs / Automerge.** `spec-offline.md §17` already evaluated
  and rejected this for single-author scale. Concurrent offline edits to
  the same draft remain LWW with explicit user conflict resolution.
- **No change to image storage.** `originals/`, `sidecars/`, `bakes/`,
  `cache/img/` and the derivative pipeline are untouched. Posts continue
  to reference image ids; the renderer resolves them at HTML time.
- **No change to the outbox / OPFS / multi-tab leader model.** Payload
  shape changes from a markdown string to a PM JSON object; transport
  is unchanged.
- **No public-URL or routing changes.**

## Format

- **On disk:** `content/posts/<slug>.json` replacing `<slug>.md`.
- **File contents:**
  ```json
  {
    "version": 1,
    "frontmatter": {
      "title": "…",
      "slug": "…",
      "date": "YYYY-MM-DD",
      "status": "draft" | "published"
    },
    "doc": { /* TipTap getJSON() output */ }
  }
  ```
- `posts.path` column in SQLite points at the `.json` file. No schema
  migration needed — the column is just a relative path string.
- JSON is pretty-printed (2-space) so it stays greppable and produces
  readable diffs when posts are inspected directly.

## Renderer

One module: `src/lib/prose-render.ts`, pure JS, no DOM deps. Exports:

```
renderDoc(doc: ProseMirrorJSON, ctx: RenderCtx): string  // HTML
```

- Walks the PM JSON node tree. Built-in nodes (paragraph, heading,
  list, blockquote, code_block, hard_break) and marks (bold, italic,
  code, link) map to standard HTML.
- Custom nodes route through a small registry so `FigureNode` and
  future nodes plug in without touching the core walker.
- `RenderCtx` carries: image-id → derivative URL resolver, slug for
  internal links, and any per-request flags (e.g. `isPreview`).
- HTML escaping is centralized; link `href` and image `src` go through
  `safeUrl()`.
- Tiptap's `@tiptap/html` `generateHTML` is an option, but a hand
  walker keeps the renderer free of DOM/jsdom and shares the schema
  with the browser preview directly.

The same module is imported by:
- Public render path (replaces `renderPostHtml` in `src/lib/content.ts`).
- Admin live preview in the browser.
- SSG / pre-warm jobs.

## Code changes

| File | Change |
|---|---|
| `src/lib/prose-render.ts` | **New.** Renderer + node registry. |
| `src/lib/post-file.ts` | **New.** `readPost(path)` / `writePost(path, post)` for the JSON envelope above; atomic write (tmp + rename). |
| `src/lib/content.ts` | Replace markdown parse + `renderPostHtml` with `readPost` + `renderDoc`. |
| `src/lib/prose-markdown.ts` | **Delete** after migration. |
| `src/admin/save.ts` | Drop `proseToMarkdown(json)`; POST `{frontmatter, doc}` directly. |
| `src/routes/admin.ts` (`POST /admin/posts`) | Accept `doc` (PM JSON) instead of `markdown`; validate against PM schema; write via `writePost`. Remove YAML frontmatter assembly. |
| `src/routes/public.ts` | No logic change beyond switching to `readPost` + `renderDoc`. |
| `src/admin/main.ts` | Live preview now calls `renderDoc(editor.getJSON(), ctx)` instead of round-tripping. |
| `src/admin/draft.ts`, `outbox.ts`, `sync.ts` | Payload type changes from `string` (markdown) to `{frontmatter, doc}`. Storage and drain logic unchanged. |
| `src/lib/sidecar-types.ts`, `image-edit-ops.ts`, `originals.ts`, `render.ts` | **No change.** |
| `migrations/` | **No new migration.** |

## Validation

- PM schema lives in one place (shared between editor extensions and
  server validator). Server uses it on `POST /admin/posts` to reject
  malformed `doc` before write — this is the new boundary check
  replacing markdown's "must parse" gate.
- `frontmatter` validated explicitly: required `title`, `slug`,
  `status`; optional `date`; reject unknown keys.

## Migration

One-shot script: `bin/migrate-md-to-json.ts`.

1. Enumerate `content/posts/*.md`.
2. For each: parse YAML frontmatter + body, run existing markdown →
   PM JSON converter (the inverse of `proseToMarkdown`; if absent,
   build it from remark AST → PM nodes — same node coverage as the
   current serializer).
3. Write `content/posts/<slug>.json` via `writePost`.
4. Update `posts.path` in SQLite to the new filename.
5. Leave `.md` files in place; a follow-up commit deletes them after
   verification.

The script is idempotent (skip if `.json` exists and is newer) and has
a `--dry-run` mode that diffs round-tripped HTML against current HTML
output per post to catch coverage gaps before commit.

## Test plan

- **Renderer unit tests** (`test/prose-render.test.ts`): one fixture
  per supported node and mark; snapshot HTML.
- **Round-trip parity test:** for every existing post, render via the
  current markdown path and via the new PM JSON path; HTML must match
  modulo whitespace. Gates the migration commit.
- **FigureNode test:** custom attrs (matrix, ids, caption, fit, width,
  aspect, timer) survive save → reload → render.
- **Save flow e2e** (`test-e2e/`): edit → save → reload → identical doc;
  offline → save → reconnect → outbox drains → file on disk matches.
- **Server validator test:** malformed `doc` payloads return 400.

## Rollout

1. Land renderer + JSON envelope behind a per-post flag (read both
   formats, prefer `.json` if present).
2. Run migration script with `--dry-run`, verify parity report.
3. Run migration for real; commit `.json` files.
4. Flip save path to write `.json` only.
5. After one stable week, delete `.md` files and `prose-markdown.ts`
   in a single cleanup commit.

## Rollback

- Steps 1–3 are non-destructive (`.md` files remain).
- After step 4: regenerate `.md` from `.json` via a JSON → markdown
  converter (only needed if rolling back; not part of the steady-state
  codebase).
- After step 5: revert from git.

## Open questions

- **Markdown → PM JSON converter:** does the existing `prose-markdown`
  module already cover the inverse direction, or does the migration
  script need it built? (Check before scheduling.)
- **PM schema sharing:** the editor's extension list lives in
  `src/admin/main.ts`; server validator needs the same schema without
  pulling in browser-only deps. Likely extract to
  `src/lib/prose-schema.ts`.
- **Pre-warm:** the existing pre-warm enqueues render jobs after save
  — confirm those jobs use the new render path, not a stale markdown
  one.

## Future: if Yjs ever becomes warranted

If concurrent offline editing of the same draft on two devices ever
becomes a real workflow, layer Yjs on top without changing the storage
model: Y.Doc is a transient live-session transport, JSON files remain
canonical, snapshot Y.Doc → PM JSON on save. No retrofit of the
storage layer required. Today this is **deferred** (see `DEFERRED.md`).
