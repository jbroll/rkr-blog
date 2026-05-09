# rkroll-cms — Offline operation specification

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
- **Single-author tolerance for conflicts.** When two devices both
  edit the same post offline, "last writer wins by sync timestamp"
  is acceptable v2 policy. Lossless conflict resolution (CRDT) is
  v3, deferred.

## 2. Non-goals

- Real-time multi-device collaboration. Two authors typing into the
  same post at the same moment is v3.
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
  author  ──▶ admin SPA ──▶ OPFS (vfs cache) ───▶ outbox ──▶ /admin/sync/*
                                                  ▲
                                                  │
                                            on `online` event
                                            (drains in seq order)
```

Two independent layers:

- **Public-side (Phase 0)**: a service worker caches `/`, `/<slug>`,
  `/img/*`, and `/static/*`. No app changes; the SPA continues to do
  what it does.
- **Admin-side (Phases 1-3)**: the editor reads + writes through an
  OPFS-backed VFS. Server API calls become outbox entries when
  offline; the outbox drains on reconnect.

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
opfs://drafts/<slug>.json                 # in-progress TipTap doc + frontmatter
opfs://originals/<id>.<ext>               # content-addressed bytes (matches server id)
opfs://sidecars/<id>.json                 # local copy of per-image ops + metadata
opfs://bakes/<id>.webp                    # post-ops baked WebP
opfs://outbox/<seq>.<op>.json             # pending API calls, sequenced
opfs://meta/<slug>.json                   # { lastSyncedAt, mode, refIds[] }
opfs://meta/_root.json                    # { schemaVersion, deviceId, refcount }
```

Notes:

- OPFS uses the API surface (FileSystemHandle / OPFSFileHandle), not a
  hand-rolled VFS over IndexedDB. Browser support: Chrome 86+, Safari
  15.2+, Firefox 111+. Browsers below this floor get the v1 experience
  (no offline authoring).
- `id` is the same sha256 client-side and server-side. A new image
  computed offline gets a stable id at creation time; reconnecting
  uploads it under that same id; server returns `{id, deduplicated}`
  with the matching id. Identity is never re-mapped during sync.
- Sharding (`<aa>/<bb>/`) is omitted client-side. Browsers don't have
  the directory-fanout problem the server's bake/cache layouts solve
  for ext4 / NTFS.
- `meta/_root.json#deviceId` is a UUID generated on first OPFS write,
  used by sync request bodies so the server can attribute origin.

## 5. Outbox

The outbox is a sequenced queue of pending server-mutating API calls.
Each entry is one of:

| op | server endpoint | payload |
|---|---|---|
| `upload` | `POST /admin/upload` | multipart with the original blob |
| `setOps` | `POST /admin/sidecar/:id/ops` | `{ ops, redoStack }` |
| `bake` | `POST /admin/sidecar/:id/bake` | binary WebP body + `X-Rkr-Bake-Ops-Hash` header |
| `savePost` | `POST /admin/posts` | `{ slug, title, status, markdown, date }` |

Properties:

- **Ordered.** Sequence number is monotonic. An `upload(X)` must drain
  before any `savePost` whose markdown references `X`, or directive
  resolution will fail server-side.
- **Idempotent on retry.** Every endpoint above is content-addressed
  or last-write-wins:
  - `upload` returns the same id for the same bytes.
  - `setOps` overwrites with the same body.
  - `bake` overwrites under the same id (gated by ops-hash; see §10).
  - `savePost` upserts by slug.
  A retry of an already-applied op is a safe no-op.
- **Atomic-in-log per entry.** Writing the OPFS file IS the commit; a
  crash mid-drain leaves the entry to retry. Drain order is "delete
  on 2xx".
- **Stops on conflict.** A 409 from any drain entry halts the queue
  and surfaces the conflict to the author. Subsequent entries do not
  drain until the conflict resolves (otherwise causal order is lost).

### Outbox JSON shape

```json
{
  "seq": 17,
  "op": "savePost",
  "createdAt": "2026-05-09T14:22:11.000Z",
  "deviceId": "8f3c…",
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
metadata only; the blob lives at a stable OPFS path:

```
opfs://outbox-blobs/<seq>.bin
```

A drained outbox entry deletes both files atomically (delete the JSON
last so a partial drain can resume from the blob).

## 6. Sync protocol

One new endpoint plus light extensions to existing ones.

### `GET /admin/post-bundle/:slug`  (new)

Returns a tarball-shaped multipart response:

```
Content-Type: multipart/mixed; boundary=…

--…
Content-Disposition: form-data; name="manifest"
Content-Type: application/json

{
  "slug": "first-day-on-the-boat",
  "title": "…",
  "status": "published",
  "date": "…",
  "lastModified": "…",
  "markdownBytes": 1234,
  "originals": [
    {"id": "abcd…", "ext": "jpeg", "bytes": 4823014},
    {"id": "ef01…", "ext": "jpeg", "bytes": 3192884}
  ],
  "sidecars": [
    {"id": "abcd…", "json": { ... }},
    {"id": "ef01…", "json": { ... }}
  ]
}
--…
Content-Disposition: form-data; name="markdown"
Content-Type: text/markdown

…
--…
Content-Disposition: form-data; name="original"; filename="abcd….jpeg"
Content-Type: image/jpeg

<binary>
--…
Content-Disposition: form-data; name="original"; filename="ef01….jpeg"
…
--…--
```

Bearer-auth (cookie auth also accepted). Returns 404 if the slug
doesn't exist or isn't owned by the requesting user.

The bundle ships originals AND sidecars in one round trip — the alternative
is N+1 separate fetches, which is unacceptable on a phone with a flaky
connection.

### `POST /admin/upload`, `/admin/sidecar/:id/ops`, `/admin/sidecar/:id/bake`, `/admin/posts`  (existing — see §11 of spec.md)

Augmented with two optional headers:

| header | shape | meaning |
|---|---|---|
| `X-Rkr-Outbox-Seq` | integer | client-side seq number; server logs it for replay debugging |
| `X-Rkr-Last-Synced-At` | ISO-8601 timestamp | the `meta.lastSyncedAt` the client believes the server had at the time of edit; used for conflict detection on `savePost` |

`X-Rkr-Bake-Ops-Hash` (header on `/bake`) is required, not optional —
see §10.

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

## 7. Pin / cache / eviction

Two ways a post gets into OPFS:

- **Pinned**: explicit operator action (a "Make available offline"
  button in the post list / editor toolbar). Stays until unpinned.
- **Cached**: the operator opened the post for editing while online,
  so it landed in OPFS as a side effect. Eviction-eligible.

`opfs://meta/<slug>.json` shape:

```json
{
  "schemaVersion": 1,
  "slug": "first-day-on-the-boat",
  "mode": "pinned",                    // "pinned" | "cached"
  "lastSyncedAt": "2026-05-09T15:01:42.000Z",
  "lastAccessedAt": "2026-05-09T15:08:11.000Z",
  "refIds": ["abcd…", "ef01…"]         // originals this post references
}
```

### Eviction policy

Ran on each app-foreground event AND on a 1-hour timer when the tab is
in foreground:

1. For each `meta/<slug>.json` with `mode = "cached"`:
   - If `lastAccessedAt > now - 7 days`: keep.
   - Else: delete `drafts/<slug>.json`, `meta/<slug>.json`. Continue.
2. After all cached evictions, recompute `_root.json#refcount` as:
   `{ id: count of meta/<slug>.json files where refIds includes id }`.
3. For each id under `originals/`:
   - If `_root.refcount[id] > 0`: keep.
   - Else: delete the original + sidecar + bake.

**Reference-counted across pinned and surviving cached posts.** An
original referenced by any still-resident post survives. The same
image used in two pinned posts is stored once.

### Quota + persistence

On first OPFS write:

```js
await navigator.storage.persist();   // best-effort; user may decline
```

Persisted storage isn't auto-evicted by the browser under storage
pressure. Non-persisted is. The author sees a warning if persistence
is denied.

Soft budget: warn the author when OPFS usage exceeds 1 GB.
`navigator.storage.estimate()` gives the number; the settings panel
displays it.

Hard budget: none. The browser eventually fails OPFS writes with
QuotaExceededError; the client surfaces "free space and try again",
the outbox stays intact for retry.

## 8. UX surface

### Status indicator (always visible in the admin SPA)

Bottom-right corner of `#rkroll-admin-root`:

| state | badge | meaning |
|---|---|---|
| `online`, outbox empty | green dot, no text | nothing to do |
| `online`, draining | spinner + "syncing N…" | outbox > 0, drain in progress |
| `online`, conflict | red badge + "1 conflict" | drain halted on 409 |
| `offline`, outbox empty | grey dot + "offline" | viewing-only ok |
| `offline`, outbox > 0 | grey dot + "offline · N pending" | edits will sync on reconnect |

Clicking the badge opens the storage panel.

### Storage panel

```
Local storage             1.2 GB / ~10 GB available
                          [persistent: yes]

Pinned posts (3)
  ☆ first-day-on-the-boat       3 originals · 14 MB
  ☆ heading-west                7 originals · 22 MB
  ☆ edinburgh                   12 originals · 48 MB

Cached posts (5, expire after 7 days)
  · ben-arthur          last opened 2 days ago      (evict)
  · loch-katrine        last opened 3 days ago      (evict)
  · …

Pending sync (2)
  ↑ savePost first-day-on-the-boat                  retry now
  ↑ upload <id>… (12 MB)                            retry now

[Sync now]  [Evict all cached]
```

### Pin button

In the post-list view (when implemented; spec.md §9 doesn't yet have
one) and in the editor toolbar, a star icon toggles pinned ↔ cached.
Pinning fetches the bundle if not already in OPFS.

## 9. Service worker (Phase 0)

`/static/sw.js` registered by every public page (post + index). Plain
service worker, no Workbox.

Caches:

- `rkr-shell-v<n>`: `/`, `/static/site.css`, `/static/site/*.js`,
  `/static/site/*.css`. Updated when bundle hash changes.
- `rkr-pages-v<n>`: `/<slug>` HTML, runtime-populated on first visit.
  LRU cap 50 posts.
- `rkr-images-v<n>`: `/img/<id>.<oph>.<fmt>`, runtime-populated.
  LRU cap 200 images.

Strategy:

- Shell: stale-while-revalidate. Sub-100ms loads.
- Pages: cache-first, fall through to network. The page's freshness
  is bounded by how often the visitor reloads.
- Images: cache-first, network-fallback. Derivatives are
  content-addressed (the `.oph.` is a hash of the ops chain), so a
  cached entry is valid until it's evicted.
- Anything else (admin, API, OAuth callbacks): network-only. The
  service worker passes through.

The admin SPA opts OUT of public-page caching. The admin shell IS
cached but separately:

- `rkr-admin-shell-v<n>`: `/admin/login`, `/admin/editor`,
  `/static/admin/main.js`, `/static/admin/main.css`. Cache-first.
- `rkr-admin-api-*`: NEVER cached. The OPFS layer is the offline
  layer for admin; the service worker stays out of API responses.

Versioned cache names so a deploy invalidates cleanly. Old caches
delete on `activate`.

## 10. Bake-ops-hash guard

Today the bake is keyed by id alone (`bakes/<id>.webp`); the server
unlinks it when ops change. With concurrent offline drains this can
race: device A sets ops=[r1], device B drains a stale bake from
ops=[r1, r2], server now serves a bake that doesn't match current
ops.

Fix:

- `POST /admin/sidecar/:id/bake` requires `X-Rkr-Bake-Ops-Hash:
  <sha256-of-canonical-json-of-ops>`.
- Server compares against `sha256(canonicalJson(sidecar.ops))`;
  rejects with 409 on mismatch.
- Client recomputes the bake against current ops and retries.

This is server-side only (~30 lines) and enabled regardless of OPFS.

## 11. Schema versioning + migration

`opfs://meta/_root.json#schemaVersion` is the OPFS layout version.
On admin SPA load:

1. Read `_root.json#schemaVersion`. If absent, treat as v0.
2. If `schemaVersion < OPFS_SCHEMA_CURRENT`: run the migration chain.
3. If `schemaVersion > OPFS_SCHEMA_CURRENT` (downgrade): refuse to
   load OPFS and surface a "browser cache is from a newer version"
   error; offer to clear it.

Migrations are simple JS functions `(handle: OPFSRoot) => Promise<void>`,
named by from→to version. The chain runs sequentially.

A schema bump is required when:
- The shape of a `meta/*.json` or `outbox/*.json` entry changes.
- A new directory is added that the eviction policy must know about.

Pure additions (new optional fields) don't bump the schema.

## 12. Conflict policy

Single tabular summary of every reconciliation point.

| Conflict | When | Resolution |
|---|---|---|
| Outbox `upload` for an id that already exists server-side | Same bytes uploaded by another device since this device went offline | Server returns `{id, deduplicated:true}`. Client deletes the outbox entry. No-op. |
| Outbox `setOps` against an id whose ops changed server-side | Two devices ran ops on the same image | Last writer wins by server `updated_at`. Client surfaces "image edits superseded" warning, allows force-replay. |
| Outbox `bake` with stale ops-hash | Bake-ops-hash mismatch | 409. Client re-bakes against current ops + re-POSTs. |
| Outbox `savePost` with stale `X-Rkr-Last-Synced-At` | Two devices edited the same post | 409. Author chooses discard vs. force-overwrite (§6). |
| Pulled bundle for a post that's been edited offline | Author runs "Sync now" while a draft is dirty | Refuse the pull; surface "you have local changes; save or discard first". |
| OPFS write fails mid-drain | QuotaExceededError | Halt drain, surface "free space" warning, keep outbox intact. |
| Two browsers, same author, both offline | Different OPFS caches | Each is independent; each syncs on its own schedule; the savePost conflict policy reconciles at the markdown level. |

## 13. Failure modes

| Failure | Behaviour |
|---|---|
| OPFS unavailable (old browser) | Editor falls back to v1 behaviour. No offline mode; status badge says "offline mode unavailable in this browser". |
| `navigator.storage.persist()` denied | OPFS still works; warn that the browser may evict under pressure. |
| Service worker fails to register | Public site still works (the SW only adds caching). Admin SPA still works. Logged to console; no user-visible effect on the happy path. |
| Sync drain hits a 5xx | Retry with backoff (mirrors `src/site/img-retry.ts`: 0.5s / 2s / 8s with 20% jitter). After 3 retries, halt; surface to user. |
| Sync drain hits a 401 | Session expired during offline period. Surface "log in to sync"; outbox preserved; drain resumes after re-login. |
| Sync drain hits a 413 | Image too large for current server config. Surface "image rejected: too large"; outbox entry stays for explicit retry-or-discard decision. |
| Browser tab killed mid-drain | Outbox JSON commits before HTTP request fires; partial drain re-attempts on next load. |
| Browser cleared site data | OPFS gone. Outbox lost. Surface "your offline cache was cleared by the browser; pull pinned posts again". |
| Two outbox entries for the same `slug`'s `savePost` | Coalesce: keep only the latest; older is redundant by definition. |

## 14. HTTP routes added or changed

```
GET  /admin/post-bundle/:slug                     new (§6)
POST /admin/sidecar/:id/bake                      requires X-Rkr-Bake-Ops-Hash (§10)
POST /admin/posts                                 honors X-Rkr-Last-Synced-At (§6)
POST /admin/upload, /admin/sidecar/:id/ops        accept X-Rkr-Outbox-Seq (logging only)
```

## 15. Phasing

| Phase | What | Lines | Depends on |
|---|---|---|---|
| 0 | PWA shell + offline-read for visitors | ~150 | nothing |
| 1 | OPFS layer + outbox + new-post-offline | ~450 | 0 |
| 2 | Pin existing posts (`/admin/post-bundle`) + edit offline | ~350 | 1 |
| 3 | TTL eviction + storage panel UI | ~250 | 2 |
| 4 | Bake-ops-hash guard | ~50 | (independent; do alongside 1) |

Phase 0 ships even without the rest; it's a strict win on the public
side and risks nothing on the admin side. Phases 1-3 are sequential.
Phase 4 is server-side only and can land any time.

## 16. Operator commands added

```
opfs:export <slug> [--out <dir>]    # for debugging: dump a slug's OPFS bundle
opfs:import <tar>                   # the inverse; not normally used
sync:status                         # show last-sync time, outbox depth (dev only)
```

These are dev/debugging tools, not regular operator workflow.

## 17. Out of scope (v2)

Adding any of these requires reopening this spec.

- Real-time collaboration (Yjs / Automerge over the TipTap doc). Tracked
  separately as v3.
- Background Sync API for drains-without-an-open-tab.
- Push notifications.
- Cross-browser-sync of OPFS contents (the OPFS in Chrome is not the
  OPFS in Safari; this is browser-vendor-level, not ours to solve).
- Reading offline as an unauthenticated visitor of *admin* pages.
  Admin offline access requires having previously logged in; the
  cookie + OPFS state are tied.
- Selective sub-post offline (caching one figure of a post but not
  the rest). Posts are the unit of pinning.
- Encryption of OPFS contents at rest beyond what the browser provides.
  OPFS data is private to the origin; we rely on the browser's
  storage isolation. A device-loss threat model is not addressed.
