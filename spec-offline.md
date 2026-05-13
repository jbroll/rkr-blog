# rkroll-cms — Offline operation specification

> **Status as of 2026-05-13: shipped.** Phase 0 (PWA shell + SW),
> Phase 1 (OPFS + outbox + drain), Phase 2 (pin existing posts),
> and Phase 3 (eviction + storage panel) have all landed. This
> document is the behavioral spec; for the as-built code map see
> `implementation.md §11 Steps 13–15`. The `IMPLEMENTATION.md`
> sibling is the per-task ledger of how each phase was delivered.

What the application does when the network is gone, and how it recovers
when the network returns. Implementation-agnostic — an alternate stack
should be able to reproduce the application from this document.

For the always-online v1 spec, see [spec.md](./spec.md). For HOW this
codebase delivers it, see [implementation.md](./implementation.md).

This is a v2 specification. Anything in here is "out of scope (v1)" in
the base spec.

---

## 1. Goals

- **Offline reading.** A visitor who has loaded a published post can
  re-open it without a network connection.
- **Offline authoring of new posts.** The author can compose a post,
  attach original images, and run image edits with no network. On
  reconnect, the work syncs to the server's filesystem-of-record.
- **Offline editing of selected existing posts.** The author marks
  specific posts for offline availability; their markdown + originals
  + sidecars are pulled to the device. Edits made offline sync on
  reconnect.
- **Predictable storage.** Cached (auto-pulled) posts time out and
  evict; pinned (explicit) posts persist until the author unpins.
  Storage usage is visible and bounded.
- **Last-writer-wins conflict policy.** When two devices edit the
  same post offline, the loser sees a warning and chooses to discard
  or force-overwrite. **No CRDT.** This is a deliberate v2 choice
  (see §17) — the cost of a CRDT layer outweighs its benefit at
  single-author scale and would force a re-modelling of the
  filesystem-of-record.

## 2. Non-goals

- **CRDT-based merge / Yjs / Automerge / any operation-transform
  layer.** Strictly out of scope. The single-author conflict surface
  is small enough that LWW with explicit user choice is the correct
  trade.
- Real-time multi-device collaboration. Two authors typing into the
  same post at the same moment is not a use case.
- Cross-browser drift. OPFS is per-origin per-browser; the same post
  edited offline in two browsers is two independent caches.
- Public-page authoring (visitors writing posts). Reading is the only
  public-side offline use case.
- Background sync without an open tab. Post-reconnect drain happens
  on the next foreground load; no Service Worker Background Sync.

## 3. Architecture (behavioral)

```
                            online                    network gone
              ┌─────────────────────────────────┐    ┌──────────────────┐
  visitor ──▶ │  service worker (cache-first)   │ ◀─ │  offline reads   │
              └────────────────┬────────────────┘    └──────────────────┘
                               │
                          public page assets
                               ▲
                               │
  author  ──▶ admin SPA ◀─▶ OPFS (vfs cache) ───▶ outbox ──▶ /admin/sync/*
                                                  ▲
                                                  │
                                            on `online` event
                                            (drains in seq order)
```

Two independent layers:

- **Public-side (Phase 0)**: a service worker caches `/`, `/<slug>`,
  `/img/*`, and `/static/*` (excluding admin). No app changes.
- **Admin-side (Phases 1-3)**: the editor reads + writes through an
  OPFS-backed VFS. Server API calls become outbox entries when
  offline; the outbox drains on reconnect. The admin SPA is **not**
  service-worker-cached — the offline path is OPFS, not the SW; this
  avoids version drift between a stale-cached SPA bundle and a fresh
  server.

The server's filesystem-of-record is unchanged. SQLite remains the
index. The browser's OPFS is a write-through cache that becomes a
write-back cache when offline.

## 4. Storage layout

### Server (unchanged from v1)

```
content/posts/<slug>.md
originals/<aa>/<bb>/<id>.<ext>           # sha256-sharded
sidecars/<id>.json
bakes/<aa>/<bb>/<id>.webp
cache/img/<aa>/<bb>/<id>.<oph>.<fmt>
data/site.db                              # index over the above
```

### Browser OPFS (new)

```
opfs://drafts/<draftId>.json              # in-progress TipTap doc + frontmatter
opfs://drafts/<draftId>.lock              # heartbeat: "this draft is in active use"
opfs://originals/<id>.<ext>               # content-addressed bytes (matches server id)
opfs://image-state/<id>.json              # full LocalEditState (current ops, redo, baseline)
opfs://bakes/<id>.webp                    # post-ops baked WebP
opfs://outbox/<seq>.<op>.json             # pending API calls, sequenced
opfs://outbox-blobs/<seq>.bin             # binary payload for upload/bake outbox entries
opfs://meta/<draftId>.json                # { slug, lastSyncedAt, mode, refIds[] }
opfs://meta/_root.json                    # { schemaVersion, deviceId }
```

Identity rules:

- **`draftId`** (UUID v4, generated on first OPFS write of a draft) is
  the OPFS-stable identity. Slug is just a property in the JSON; the
  author can rename the slug freely without renaming files.
- **`id`** for images is the same sha256 client-side and server-side.
  A new image computed offline gets a stable id at creation time;
  reconnecting uploads it under that same id; the server returns
  `{id, deduplicated}` with the matching id. Identity is never
  re-mapped during sync.

Notes:

- OPFS uses the FileSystemHandle API directly (not a hand-rolled VFS
  over IndexedDB). Browser support: Chrome 86+, Safari 15.2+, Firefox
  111+. Browsers below this floor get the v1 experience (no offline
  authoring); the SPA detects support and surfaces "offline mode
  unavailable in this browser" rather than failing.
- Sharding (`<aa>/<bb>/`) is omitted client-side. Browsers don't have
  the directory-fanout problem the server's bake/cache layouts solve
  for ext4 / NTFS.
- `meta/_root.json#deviceId` is a UUID generated on first OPFS write,
  used by sync request bodies so the server can attribute origin
  during debugging.
- `image-state/<id>.json` carries the live `LocalEditState` —
  `{ops, redoStack, baseline:{ops, redoStack}, sourceWidth,
  sourceHeight}`. The server's sidecar is server-only; OPFS holds
  the editor's working state, including the `baseline` snapshot
  needed to compute `isDirty`.
- No reference count is stored. Eviction recomputes "what's
  referenced by surviving meta files" each pass — drift-free at the
  cost of one O(N) walk per eviction (N ≈ pinned + cached posts,
  small).

## 5. Outbox

The outbox is a sequenced queue of pending server-mutating API calls.
Each entry is one of:

| op | server endpoint | payload |
|---|---|---|
| `upload` | `POST /admin/upload` | multipart with the original blob |
| `setOps` | `POST /admin/sidecar/:id/ops` | `{ ops, redoStack }` |
| `bake` | `POST /admin/sidecar/:id/bake` | binary WebP body + `X-Rkr-Bake-Ops-Hash` header (see spec.md §7) |
| `savePost` | `POST /admin/posts` | `{ slug, title, status, markdown, date }` |

Properties:

- **Globally ordered.** Sequence number is monotonic across all
  tabs of the same origin. See §5.1 (multi-tab coordination).
- **Causally complete on drain.** An `upload(X)` must drain before
  any `savePost` whose markdown references `X`, or directive
  resolution will fail server-side. The seq order guarantees this.
- **Idempotent on retry.** Every endpoint is content-addressed or
  upserts:
  - `upload` returns the same id for the same bytes.
  - `setOps` overwrites with the same body.
  - `bake` overwrites under the same id (gated by ops-hash).
  - `savePost` upserts by slug.
  A retry of an already-applied op is a safe no-op.
- **Atomic-in-log per entry.** Writing the OPFS file IS the commit;
  a crash mid-drain leaves the entry to retry. Drain order is
  "delete on 2xx".

### Outbox JSON shape

```json
{
  "seq": 17,
  "op": "savePost",
  "createdAt": "2026-05-09T14:22:11.000Z",
  "deviceId": "8f3c…",
  "draftId": "21f6…",
  "payload": {
    "slug": "first-day-on-the-boat",
    "title": "First day on the boat",
    "status": "published",
    "date": "2026-05-09T08:00:00.000Z",
    "markdown": "…\n\n::figure{ids=\"abcd…,ef01…\" matrix=\"1x2\"}\n…"
  },
  "blobRef": null
}
```

For ops that carry binary (`upload`, `bake`), the JSON file holds
metadata only; the blob lives at `opfs://outbox-blobs/<seq>.bin`.
Drain deletes the blob first, the JSON last — a partial drain
re-fetches from the JSON.

### 5.1. Multi-tab coordination

Two tabs of `/admin/editor` share one OPFS. To keep the outbox seq
monotonic and avoid two parallel drains, the SPA elects a single
**leader** via the Web Locks API:

```
navigator.locks.request('rkr-sync-leader', { mode: 'exclusive' }, ...)
```

The leader runs the drain loop and is the sole writer of new outbox
seqs. Non-leader tabs:

- Append to the outbox via the leader (broadcast-channel-mediated, or
  the leader holds an in-memory append queue keyed on lock release).
- Show the same status indicator state, derived from a
  `BroadcastChannel('rkr-sync')` that the leader publishes to.

If the leader's tab closes, the lock releases; the next requester
becomes leader. A drain in flight at lock-release boundary completes
or aborts cleanly (the in-flight HTTP request either succeeds and the
new leader sees the deleted outbox entry, or fails and the new leader
retries — both safe due to idempotency).

### 5.2. Drain failure handling

Single source of truth for what happens on each response class:

| status | behaviour |
|---|---|
| 2xx | delete entry, advance to next |
| 409 (conflict) | halt drain; surface conflict to user; do not advance until resolved |
| 4xx (other, e.g. 413, 422) | halt drain; surface "this request was rejected: \<message\>"; offer discard or fix-and-retry |
| 5xx | retry with backoff (1s / 2s / 4s / 8s / 16s; `src/admin/sync.ts:RETRY_DELAYS_MS`); after the schedule is exhausted halt and surface |
| network error | same as 5xx |
| 401 | halt; surface "log in to continue sync"; outbox preserved across login |

When an entry is permanently discarded by the user (413 image too
large, etc.), the queue scans subsequent entries for references to
the discarded entry's outputs (uploaded id, etc.) and removes them
too with a single confirmation: "discarding X also drops 3 dependent
operations". No silent dependency drops.

## 6. Sync protocol

One new endpoint plus light extensions to existing ones.

### `GET /admin/post-bundle/:slug?manifest=1` (new)

Returns JSON describing what the client needs to fetch:

```json
{
  "slug": "first-day-on-the-boat",
  "title": "…",
  "status": "published",
  "date": "…",
  "lastModified": "2026-05-09T13:14:00.000Z",
  "markdown": "…",
  "originals": [
    {"id": "abcd…", "ext": "jpeg", "bytes": 4823014},
    {"id": "ef01…", "ext": "jpeg", "bytes": 3192884}
  ],
  "sidecars": [
    {"id": "abcd…", "json": { ... }},
    {"id": "ef01…", "json": { ... }}
  ]
}
```

The manifest is small (KB), even for large galleries. Originals are
fetched separately via the existing `GET /admin/original/:id`. The
client can:

- Fetch all originals in parallel with bounded concurrency.
- Resume on flaky connections (each fetch is a discrete request).
- Skip originals already present in OPFS by id.
- Display per-image progress.

The all-in-one bundle was rejected for v2: a 500MB multipart on a 4G
connection that drops mid-stream gets the user nothing usable.

### Existing endpoints — augmented headers

| header | added on | shape | meaning |
|---|---|---|---|
| `X-Rkr-Outbox-Seq` | upload, setOps, bake, savePost | integer | client-side seq number; server logs for replay debugging |
| `X-Rkr-Last-Synced-At` | savePost | ISO-8601 | the `meta.lastSyncedAt` the client believed the server had at the time the OFFLINE EDITS BEGAN. Not the time of drain — the time of the last successful pull |
| `X-Rkr-Bake-Ops-Hash` | bake | sha256 hex | (already required per spec.md §7) |

### `savePost` conflict response

When a `savePost` arrives with `X-Rkr-Last-Synced-At` older than the
post's current `updated_at`, the server returns:

```
HTTP/1.1 409 Conflict
Content-Type: application/json

{
  "error": "post-superseded",
  "slug": "first-day-on-the-boat",
  "serverUpdatedAt": "2026-05-09T15:01:42.000Z",
  "clientLastSyncedAt": "2026-05-09T13:14:00.000Z"
}
```

The client surfaces this to the author with two options:

- **Discard local edits**: drop the outbox entry, re-fetch the bundle.
- **Force overwrite**: re-POST `/admin/posts` without the
  `X-Rkr-Last-Synced-At` header. Server accepts.

The client cannot silently overwrite. The author makes the call.

`setOps` and `bake` use last-writer-wins without 409 (per the conflict
policy table in §12) — image-edit ops are small and fast to redo, so
the LWW failure mode is "your rotate got overwritten by another
device's flip" which the user notices visually.

## 7. Pin / cache / eviction

Two ways a post gets into OPFS:

- **Pinned**: explicit operator action. A "Make available offline"
  button in the post list / editor toolbar. Stays until unpinned.
- **Cached**: opened for editing while online, so it landed in OPFS
  as a side effect. Eviction-eligible.

`opfs://meta/<draftId>.json` shape:

```json
{
  "schemaVersion": 1,
  "draftId": "21f6…",
  "slug": "first-day-on-the-boat",
  "mode": "pinned",
  "lastSyncedAt": "2026-05-09T15:01:42.000Z",
  "lastAccessedAt": "2026-05-09T15:08:11.000Z",
  "refIds": ["abcd…", "ef01…"]
}
```

`lastAccessedAt` is updated on each open of the corresponding draft.

### Eviction policy

Eviction runs:
- on every editor mount (admin SPA load), AND
- after each successful sync drain that returns the queue to empty.

No periodic timer.

Steps:

1. For each `meta/<draftId>.json` with `mode = "cached"` AND
   `lastAccessedAt < now - 7 days` AND no `drafts/<draftId>.lock`
   present (post is not in active use): delete `drafts/<draftId>.json`,
   `meta/<draftId>.json`, and any related `image-state/*.json` whose
   id appears only in this post.
2. After all cached evictions, walk the surviving `meta/*.json` files
   and compute `referenced = ⋃ refIds`.
3. For each id under `originals/`: if `id ∉ referenced`: delete the
   original + its `sidecars/<id>.json` + its `bakes/<id>.webp` (if
   present).

Reference-counted reclamation across pinned + surviving cached
posts. An original referenced by any still-resident post survives.
Same image used in two posts is stored once.

### In-use guard

`drafts/<draftId>.lock` is a heartbeat marker:

- Created when the editor opens a draft.
- Touched (mtime updated) every 30 seconds while the editor is
  visible (not on hidden tabs).
- Deleted on `unload`.
- A lock newer than now - 60s is considered live; older locks are
  treated as stale and ignored by eviction. (`LOCK_GRACE_MS` in
  `src/lib/eviction-pure.ts`; must stay ≥ 2 × `HEARTBEAT_MS`.)

This prevents an "evict cached post that's been sitting open in the
editor for 8 days" data-loss path.

### Quota + persistence

On first OPFS write:

```js
await navigator.storage.persist();   // best-effort; user may decline
```

Persisted storage isn't auto-evicted by the browser under storage
pressure. Non-persisted is. The SPA surfaces a warning if persist
is declined.

Default **soft budget** (tunable, see §17 Defaults): warn the
author when OPFS usage exceeds 1 GB. `navigator.storage.estimate()`
gives the number; the storage panel displays it.

Hard budget: none. The browser eventually fails OPFS writes with
QuotaExceededError; the SPA surfaces "free space and try again", the
outbox stays intact for retry.

## 8. UX surface

### Online detection

`navigator.onLine` is consulted but is unreliable (returns `true` on
"wifi without internet"). The SPA additionally probes:

- A 5-second-interval HEAD to `/health` while in any of {`offline`
  per onLine, last sync had a network error, last-known status
  older than 60 seconds and the user is interacting}.
- The `online` / `offline` window events drive an immediate probe.

State machine: `online` ↔ `verifying` ↔ `offline`. The UI shows
`verifying` only when the state is uncertain; brief flickers don't
surface.

### Status indicator

Bottom-right corner of `#rkroll-admin-root`. The exact visual is
implementation choice; the contract is:

- shows current connectivity state (online / verifying / offline);
- shows pending outbox depth when > 0;
- shows a conflict count when drain is halted on a 409;
- click opens the storage panel.

### Storage panel

Contract:

- Total OPFS usage and persistence state.
- List of pinned posts with per-post storage cost and unpin action.
- List of cached posts with last-opened time and explicit-evict
  action.
- Pending sync queue with per-item retry / discard actions.
- "Sync now" trigger and "Evict all cached" trigger.
- Schema version (for support).

Visual layout is implementation detail.

### Pin button

Toggles pinned ↔ cached for the current post (or a post in the
list). Pinning fetches the bundle if not already in OPFS;
unpinning marks `mode = "cached"`, eligible for the 7-day timer.

### Draft persistence frequency

The TipTap document is written to OPFS on:

- 500ms of typing inactivity (debounced), AND
- editor blur.

Worst-case data loss is 500ms of typing if the tab is killed
mid-keystroke. The image-edit `LocalEditState` is written
synchronously after each op (rotate / flip / etc.) — those are
single events, not streams.

## 9. PWA install + service worker (Phase 0)

### Manifest

`/manifest.webmanifest` served from the public root:

```json
{
  "name": "rkroll",
  "short_name": "rkroll",
  "description": "Photo-first single-author blog.",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#1a4f7f",
  "icons": [
    {"src": "/static/site/icon-192.png", "sizes": "192x192", "type": "image/png"},
    {"src": "/static/site/icon-512.png", "sizes": "512x512", "type": "image/png"}
  ]
}
```

`scope: "/"` covers both public reading and admin authoring. The
admin SPA detects "installed" via `display-mode: standalone` and
shows a slightly different chrome (no browser address bar, so no
"go back to the public site" via back-button — the SPA needs a Home
link).

### Service worker

`/sw.js` registered by the public-page templates. Plain service
worker, no Workbox. **Not** registered by the admin SPA — admin
offline goes through OPFS (§3 explanation).

Caches:

| name | content | strategy | size |
|---|---|---|---|
| `rkr-shell-v<n>` | `/`, `/static/site.css`, `/static/site/*.js`, `/static/site/*.css`, manifest, icons | stale-while-revalidate | bounded by file count |
| `rkr-pages-v<n>` | `/<slug>` HTML, runtime-populated | stale-while-revalidate, LRU-bounded | tunable cap (default 50, see §17 Defaults) |
| `rkr-images-v<n>` | `/img/<id>.<oph>.<fmt>`, runtime-populated | cache-first, network-fallback | tunable cap (default 200, see §17 Defaults) |

Admin routes, OAuth callbacks, and `/admin/*` API endpoints are
**not** intercepted — the SW falls through to network for them.

Stale-while-revalidate on pages: visitors see the cached copy
immediately; the SW background-fetches the latest and updates the
cache for next visit. No stale-forever risk.

Versioned cache names so a deploy invalidates cleanly. Old caches
delete on `activate`.

### Bundle URL versioning

Both public and admin bundles ship with content-hashed filenames
(`/static/site/lightbox.<hash>.js`, `/static/admin/main.<hash>.js`).
The HTML template references the hashed name. After a deploy the URL
changes; the SW's stale-while-revalidate naturally picks up the new
file; the admin SPA (not SW-cached) fetches fresh via the new URL.

Without this, a SW-cached bundle URL serves stale code indefinitely.

## 10. Schema versioning + migration

`opfs://meta/_root.json#schemaVersion` is the OPFS layout version.
On admin SPA load:

1. Read `_root.json#schemaVersion`. If absent, treat as v0.
2. If `schemaVersion < OPFS_SCHEMA_CURRENT`: run the migration chain.
3. If `schemaVersion > OPFS_SCHEMA_CURRENT` (downgrade): refuse to
   load OPFS. Surface "browser cache is from a newer version. Sync
   pending changes via the v-newer device, or reset (destructive)."

Migrations are functions `(handle: OPFSRoot) => Promise<void>`,
named by `from→to` version. The chain runs sequentially.

### Migration atomicity

Each migration:

1. Writes its results into `opfs://_migration-<from>-<to>/` (a
   parallel tree).
2. On success, atomically swaps via two writes: rename
   `_root.json.tmp` → `_root.json` (the version bump is the LAST
   step; see below).
3. Old data is deleted only after the version bump lands.

The version bump is the commit point. A crash before it leaves the
old layout intact, plus a `_migration-<from>-<to>/` tree on disk.
The next run sees `schemaVersion = from`, ignores the partial
tmp tree, and retries the migration.

A schema bump is required when:
- The shape of a `meta/*.json` or `outbox/*.json` entry changes.
- A new directory is added that the eviction policy must know about.

Pure additions (new optional fields) don't bump the schema.

## 11. Conflict policy

Single tabular summary of every reconciliation point.

| Conflict | When | Resolution |
|---|---|---|
| `upload` for an id that already exists server-side | Same bytes uploaded by another device since this device went offline | Server returns `{id, deduplicated:true}`. Client deletes the outbox entry. No-op. |
| `setOps` against an id whose ops changed server-side | Two devices ran ops on the same image | Last writer wins by server `updated_at`. Visual change is immediately apparent to the user; no 409. |
| `bake` with stale ops-hash | Bake-ops-hash mismatch | 409 (per spec.md §7). Client re-bakes against current ops + re-POSTs. |
| `savePost` with stale `X-Rkr-Last-Synced-At` | Two devices edited the same post | 409. Author chooses discard vs. force-overwrite (§6). |
| Pulled bundle for a post that's been edited offline | Author runs "Sync now" while a draft is dirty | Refuse the pull; surface "you have local changes; save or discard first". |
| OPFS write fails mid-drain | QuotaExceededError | Halt drain, surface "free space" warning, keep outbox intact. |
| Two browsers, same author, both offline | Different OPFS caches | Each is independent; each syncs on its own schedule; the `savePost` policy reconciles at the markdown level. |
| Two tabs, same browser, both online | Single OPFS, leader-elected drain (§5.1) | Leader does the drain; non-leader tabs reflect state via BroadcastChannel. No conflict. |

## 12. Failure modes

| Failure | Behaviour |
|---|---|
| OPFS unavailable (browser pre-2022) | Editor falls back to v1 behaviour. Status badge says "offline mode unavailable in this browser". |
| `navigator.storage.persist()` denied | OPFS still works; warn that the browser may evict under storage pressure. |
| Service worker fails to register | Public site still works. Logged to console; no user-visible effect on the happy path. |
| Sync drain hits 5xx | Retry with backoff; after 3 retries halt (per §5.2). |
| Sync drain hits 401 (session expired) | Outbox preserved across re-login. Surface "log in to sync N pending changes". OPFS contents and outbox survive sign-out — they're tied to the origin, not the session. |
| Sync drain hits 413 (image too large) | Outbox entry stays for explicit retry-or-discard. Discarding offers to also drop dependent entries (§5.2). |
| Browser tab killed mid-drain | Outbox JSON commits before HTTP request fires; partial drain re-attempts on next load. |
| Browser cleared site data | OPFS gone. Outbox lost. Surface "your offline cache was cleared by the browser; pull pinned posts again" on next online connect. |
| Two outbox entries for the same `slug`'s `savePost` | Coalesce within the not-yet-drained queue: keep only the latest. Drained entries are removed normally; coalesce applies only to pending. |
| Two outbox entries `setOps` for the same `id` | Same coalescing as above. |
| Image format the browser can't preview-decode (e.g. HEIC on a non-Safari) | Upload outbox entry succeeds (server has sharp); preview shows a placeholder; no failure. |
| OPFS handle invalidated by long backgrounding | Some browsers expire handles. SPA re-acquires the root handle on every editor mount; doesn't rely on cross-load handle stability. |
| User signs out | Cookie cleared; OPFS untouched. Next login resumes outbox drain. |

## 13. HTTP routes added or changed

```
GET  /admin/post-bundle/:slug?manifest=1   new (§6) — manifest only
GET  /manifest.webmanifest                 new (§9)
GET  /sw.js                                new (§9)
POST /admin/sidecar/:id/bake               (already requires X-Rkr-Bake-Ops-Hash per spec.md §7)
POST /admin/posts                          honors X-Rkr-Last-Synced-At (§6)
POST /admin/upload, /admin/sidecar/:id/ops accept X-Rkr-Outbox-Seq (logging only)
```

## 14. Phasing

| Phase | What | Lines | Depends on |
|---|---|---|---|
| 0 | PWA shell + offline-read for visitors | ~150 | nothing |
| 1 | OPFS layer + outbox + new-post-offline | ~450 | 0 |
| 2 | Pin existing posts (`/admin/post-bundle`) + edit offline | ~350 | 1 |
| 3 | TTL eviction + storage panel UX | ~250 | 2 |

Phase 0 ships even without the rest; it's a strict win on the public
side and risks nothing on the admin side. Phases 1-3 are sequential.

The bake-ops-hash guard (called out in spec.md §7) is independent of
phasing and should land in v1.

## 15. Operator-facing debug

There is no CLI access to OPFS contents — OPFS is browser-private
and the operator's CLI runs server-side.

Browser-side: the storage panel offers an "Export OPFS as JSON" button
for support cases. The export is best-effort: it ships meta + draft
JSON (not blobs). The operator can email or paste the export when
diagnosing a sync problem.

## 16. Defaults (tunable)

| Default | Value | Tuning surface |
|---|---|---|
| Cache TTL for `mode = "cached"` posts | 7 days | settings panel |
| OPFS soft-budget warning | 1 GB | settings panel |
| `rkr-pages-v<n>` LRU cap | 50 | build-time constant |
| `rkr-images-v<n>` LRU cap | 200 | build-time constant |
| Online-probe interval (offline state) | 5s | build-time constant |
| Sync-drain 5xx backoff | 1s / 2s / 4s / 8s / 16s | build-time constant in `src/admin/sync.ts` |
| Public /img cache-miss backoff | 0.5s / 1.5s / 3s / 6s / 10s ±20%, capped at 10s | build-time constant in `src/site/img-retry.ts` |
| Draft-write debounce | 500ms | build-time constant |
| Draft in-use heartbeat / stale | 30s / 60s | `HEARTBEAT_MS` in `src/admin/draft.ts`, `LOCK_GRACE_MS` in `src/lib/eviction-pure.ts` |
| Drain leader election | `navigator.locks.request('rkr-sync-leader', …)` | browser-managed (no heartbeat — held for the callback's lifetime, released on tab close) |

## 17. Out of scope (v2)

Adding any of these requires reopening this spec.

- **CRDT / Yjs / Automerge / any operation-transform layer.**
  Strictly out of scope. Single-author conflict surface is small
  enough that LWW with explicit choice is the correct trade.
- Real-time multi-device collaboration in any form.
- Background Sync API for drains-without-an-open-tab.
- Push notifications.
- Cross-browser sync of OPFS contents (Chrome OPFS ≠ Safari OPFS;
  this is browser-vendor-level, not ours to solve).
- Reading offline as an unauthenticated visitor of *admin* pages.
  Admin offline access requires having previously logged in; the
  cookie + OPFS state are tied.
- Selective sub-post offline (caching one figure of a post but not
  the rest). Posts are the unit of pinning.
- Encryption of OPFS contents at rest beyond what the browser
  provides. OPFS data is private to the origin; we rely on the
  browser's storage isolation. A device-loss threat model is not
  addressed.
- WebRTC / direct device-to-device sync (see CRDT — not happening).
