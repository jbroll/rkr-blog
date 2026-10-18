# Google Photos Picking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the editor import photos and videos the user picks from their full Google Photos library.

**Architecture:** The Library API cannot do this (since 2025-04 it returns app-created items only), so this uses the Photos Picker API: server creates a picking session, the client opens Google's `pickerUri` in a new tab, polls completion through the server, lists the picked items, and imports selections through the existing ingest pipeline. Provider key `gphotos`; same Google OAuth client as Drive (no new secrets), new `photospicker.mediaitems.readonly` grant, new redirect URI.

**Tech Stack:** TypeScript + Fastify (server), vanilla DOM + `<dialog>` (admin client), node:test, Playwright (chromium, self-booting webServer).

**Spec:** `docs/spec.md` (Drive/OneDrive provider rows — Task 6 adds the Photos row). This plan argues from the Drive/OneDrive implementations as reference: `src/lib/google-drive.ts`, `src/routes/integrations-gdrive.ts`, `src/admin/integrations/provider-helpers.ts`, `src/routes/admin-settings.ts` + `src/templates/admin-settings.ts` (configured-gated rows).

## Global Constraints

- ES modules, kebab-case filenames, no top-level side effects (`docs/developer-quickstart.md` §4).
- `npx biome check` clean on every touched file.
- `npx tsc --noEmit` clean; `npx tsc -p tsconfig.e2e.json --noEmit` clean for `src/admin/**` + `test/e2e/**` + `test/admin/**`.
- c8 per-file gates: lines 90, branches 75, functions 90 on `src/**`.
- Production sources under the 500-line cap; tests exempt.
- Every `export` must be imported somewhere (knip gate).
- TDD throughout. e2e runs against the built bundle — run `npm run build:admin` after `src/admin/**` changes before Playwright.

## Review Focus

1. User opens the Google tab but never picks (closes it) — dialog polling must time out via the session `pollingConfig.timeoutIn` into an expired state with a retry path, never spin forever; test pins it in the task owning the dialog.
2. Session expires between list and import (`baseUrl` ~60 min) — import re-lists the session and 400s cleanly when the item is gone, instead of ingesting an error page; test pins it in the task owning import.
3. Video picks — `mediaType` video items import through the `/video` endpoint and list under `kind=video`; test pins it in the dialog task.
4. Disconnect/revoke mid-flow — every endpoint surfaces 404/412 JSON the dialog renders as text, no hang; tests pin it in the route task.
5. Hostile filenames from Photos (`filename` with markup) — rendered via `textContent` only; test pins it in the dialog task.

## Setup (operator, not code)

No new secrets. Before use, in the shared Cloud project: enable the **Google Photos Picker API**, and add `https://<admin-host>/admin/integrations/gphotos/callback` (each site's admin host) to the OAuth client's Authorized redirect URIs. Task 6 documents this in RUNBOOK.

---

### Task 1: Photos Picker API lib + unit tests

**Files:**
- Create: `src/lib/photos-picker.ts`
- Test: `test/lib/photos-picker.test.ts`

**Model:** `sonnet` — new third-party API shape, verify field names against the Picker API reference (`developers.google.com/photos/picker/reference/rest`) while implementing; missing/renamed fields fail closed (throw, don't default).

**Interfaces:**
- Consumes: bearer-token auth only (plain `fetch` + `opts.fetcher` injection like siblings; no redirect-chasing needed — all hosts are `photospicker.googleapis.com`, but route every request through `assertSafeFetchUrl` from `src/lib/url-safety.ts` anyway).
- Produces: `PHOTOS_PICKER_SCOPE = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly'`; `createPickingSession(accessToken, opts?) => Promise<{ sessionId: string; pickerUri: string; pollIntervalMs: number; timeoutMs: number }>` (`POST https://photospicker.googleapis.com/v1/sessions`, map `pollingConfig`); `getPickingSession(accessToken, sessionId, opts?) => Promise<{ done: boolean }>` (`GET .../v1/sessions/{id}`, `done = mediaItemsSet === true`); `listSessionMediaItems(accessToken, sessionId, opts?: { fetcher?; pageToken? }) => Promise<{ items: PickedItem[]; nextPageToken: string | null }>` (`GET .../v1/sessions/{id}/mediaItems`, map `mediaFile: { baseUrl, filename, mimeType }` + photo/video kind from `mediaFileMetadata`); `PickedItem = { id: string; name: string; mimeType: string; thumbnailUrl: string; downloadUrl: string; kind: 'image' | 'video' }` (thumbnail `=w256-h256`, download `=d` suffixes on `baseUrl`); `deletePickingSession(accessToken, sessionId, opts?) => Promise<void>` (`DELETE`, tolerate 404); non-OK → `Error('photos <op>: HTTP <status>')`.

- [ ] **Step 1: Write failing tests** in `test/lib/photos-picker.test.ts` (stub `fetcher`, no network):
  - `createPickingSession maps id/pickerUri/pollingConfig`.
  - `getPickingSession reports done only when mediaItemsSet is true` (both cases).
  - `listSessionMediaItems maps photo + video items with thumb/download URLs` (assert `=w256-h256` / `=d` suffixes, kind mapping).
  - `listSessionMediaItems forwards pageToken and surfaces nextPageToken`.
  - Each op throws `/photos <op>: HTTP \d+/` on non-OK (one test per op, table of four).
  - `deletePickingSession tolerates 404 but throws on 500`.
- [ ] **Step 2: Run to verify they fail**

  Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types --conditions=development test/lib/photos-picker.test.ts`
  Expected: FAIL (module/exports missing).
- [ ] **Step 3: Implement** `src/lib/photos-picker.ts` per the Interfaces block.
- [ ] **Step 4: Run to verify they pass**

  Run: same command as Step 2.
  Expected: PASS, whole file green.
- [ ] **Step 5: Commit**

```bash
git add src/lib/photos-picker.ts test/lib/photos-picker.test.ts
git commit -m "photos: add Picker API session wrapper"
```

### Task 2: `gphotos` OAuth + session/import routes + tests

**Files:**
- Create: `src/routes/integrations-gphotos.ts`
- Modify: `src/server.ts` (register behind `gphotosConfigured()`), `src/lib/config.ts` (add `gphotosOAuthConfigured`, same gate shape as gdrive: `GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && adminBaseUrl`)
- Test: `test/routes/integrations-gphotos.test.ts`

**Model:** `sonnet` — mirrors `integrations-gdrive.ts` route-for-route with a different exchange scope and PKCE cookie name.

**Interfaces:**
- Consumes: Task 1 lib; arctic `Google` class (same import as gdrive route); `createPendingStore`, token helpers, `readSecretKey`, `safeErr`/`safeDescription` (log `description` on exchange failure like the OneDrive route).
- Produces: provider key `'gphotos'`, state cookie `rkr_gphotos_state`; routes (all under `/admin/integrations/gphotos/`, guards mirroring gdrive: owner for connect/callback/disconnect, user for the rest): `connect` → 302 Google with `PHOTOS_PICKER_SCOPE` + `access_type=offline` + `prompt=consent`; `callback` → exchange, store, 302 `/admin/settings`; `status` → `{ connected }`; `disconnect` → `{ removed }`; `POST sessions` → `{ sessionId, pickerUri }` (append `/autoclose` to the pickerUri before returning); `GET sessions/:id` → `{ done }`; `GET sessions/:id/media-items?pageToken?` → `{ items: [{ id, name, mimeType, thumbnailUrl, kind }], nextPageToken }` (NEVER expose `downloadUrl`/`baseUrl` to the browser); `POST /admin/import/gphotos { sessionId, mediaItemId }` → image ingest result shape (re-list session, find item, stream `downloadUrl` through the byte-cap limiter + `ingestStream` exactly like the gdrive import route); `POST /admin/import/gphotos/video` → `ingestRemoteVideo` result (via `videoImportError` mapping like gdrive's). Unconnected → 404 `{ error: 'gphotos not connected' }` on session/import routes (mirror gdrive `/files` precedent).

- [ ] **Step 1: Write failing tests** in `test/routes/integrations-gphotos.test.ts` (mirror `integrations-gdrive.test.ts` `setup()` + stub-exchange + legacy-JSON state-cookie callback connect pattern; stub Google token endpoints via injected exchange, stub Picker API via injected `pickerFetcher` opt on the route opts):
  - `connect redirects with offline + prompt=consent and photos scope` (assert authorize URL contains `photoslibrary` scope marker).
  - `callback exchanges code, stores gphotos tokens, redirects to /admin/settings`.
  - `status reflects connection` (false then true after connect).
  - `POST sessions creates a picking session` (returns sessionId + pickerUri ending `/autoclose`).
  - `GET sessions/:id reports done flag` (false then true across two fixture states).
  - `GET sessions/:id/media-items maps items without download URLs` (assert no `downloadUrl`/`baseUrl` key in response JSON).
  - `POST /admin/import/gphotos ingests the item` (stub download bytes; assert id/bytes/ext shape; assert non-image content-type → 415).
  - `POST /admin/import/gphotos/video ingests video` (stub video bytes; assert cache-URL shape per the gdrive video test — read it first).
  - `session/import routes 404 when unconnected`; `disconnect removes tokens`.
  - `server registers gphotos routes only when configured` (buildApp without exchange/env → `/admin/integrations/gphotos/status` 404s; covered implicitly if other tests inject — make it explicit with one test).
- [ ] **Step 2: Run to verify they fail**

  Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types --conditions=development test/routes/integrations-gphotos.test.ts`
  Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `src/routes/integrations-gphotos.ts` + `server.ts`/`config.ts` wiring per Interfaces.
- [ ] **Step 4: Run to verify they pass**

  Run: same command as Step 2, plus `test/lib/config.test.ts` (new `gphotosOAuthConfigured` cases — add them in this task: true when full, false when secret/base missing).
  Expected: PASS, all files green.
- [ ] **Step 5: Commit**

```bash
git add src/routes/integrations-gphotos.ts src/server.ts src/lib/config.ts test/routes/integrations-gphotos.test.ts test/lib/config.test.ts
git commit -m "photos: add gphotos OAuth, session and import routes"
```

### Task 3: Settings row for Google Photos

**Files:**
- Modify: `src/templates/admin-settings.ts`, `src/routes/admin-settings.ts`
- Test: `test/templates/admin-settings.test.ts`, `test/routes/admin-settings.test.ts`

**Model:** `sonnet` — third row following the established two-row pattern exactly.

**Interfaces:**
- Consumes: Task 2 `gphotosOAuthConfigured()`.
- Produces: settings shows `Google Photos` row with Connect (`/admin/integrations/gphotos/connect`) vs `Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable` hint vs Disconnect (`/admin/settings/gphotos/disconnect` — new route in `registerAdminSettingsRoutes` mirroring the two existing disconnect routes).

- [ ] **Step 1: Write failing tests**: template — unconfigured shows hint naming the vars and no connect link; configured+unconnected shows the connect link; connected shows Disconnect. Route — GET `/admin/settings` with OAuth env stripped omits the gphotos connect link; `POST /admin/settings/gphotos/disconnect` removes the token row and 303s to `/admin/settings`.
- [ ] **Step 2: Run to verify they fail**

  Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types --conditions=development test/templates/admin-settings.test.ts test/routes/admin-settings.test.ts`
  Expected: FAIL (no gphotos row).
- [ ] **Step 3: Implement** the template row (extend `renderIntegrations` data + call), the route flags, and the settings disconnect route.
- [ ] **Step 4: Run to verify they pass**

  Run: same command as Step 2.
  Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/templates/admin-settings.ts src/routes/admin-settings.ts test/templates/admin-settings.test.ts test/routes/admin-settings.test.ts
git commit -m "settings: add Google Photos integration row"
```

### Task 4: Photos session dialog + source-picker entry + e2e

**Files:**
- Create: `src/admin/integrations/gphotos.ts`
- Modify: `src/admin/source-picker.ts` (`SourceChoice` gains `'photos'`), `src/admin/image-insert.ts`, `src/admin/video-insert.ts` (route the new choice to `pickFromPhotos` / `pickFromPhotosVideo`), source-picker dialog markup that renders the choice buttons (find it — likely `src/admin/source-picker.ts` or the editor template; add the Photos button alongside Drive/OneDrive with the same `data-source` contract)
- Test: `test/e2e/editor-flow.spec.ts` (new `gphotos:` block)

**Model:** `sonnet` — new UX flow (session dialog) plus wiring across three client files.

**Interfaces:**
- Consumes: Task 2 endpoints; `openModal`, `setStatus`, `ensureConnected` (same imports as siblings).
- Produces: `pickFromPhotos(): Promise<string[]>`, `pickFromPhotosVideo(): Promise<string[]>` (same resolve-`[]`-on-cancel contract); dialog flow: ensureConnected → `POST sessions` → dialog with status text + `Open Google Photos` button (`window.open(pickerUri, '_blank', 'noopener')`) + Cancel → poll `GET sessions/:id` every `pollIntervalMs` (from create response; cap 5s) until `done` or session expiry → list items as a checkbox grid reusing `rkr-cb-*` classes where they fit (new `photos-` prefixed classes only where the browser chrome genuinely differs) → Import posts each id to `/admin/import/gphotos[v/ideo]` → resolve ids; timeout/expire → expired copy + Try-again (re-create) path; all names via `textContent`.

- [ ] **Step 1: Write the e2e block first (failing)**: route mocks — `/status` connected, `POST sessions` → `{ sessionId: 'sess-1', pickerUri: 'https://photos.google.com/picker?x' }`, `GET sessions/sess-1` → first `{ done: false }` then `{ done: true }`, `media-items` → two items (photo + video) with data-URI thumbnails, import endpoints → fixed ids. Stub `window.open` via `page.addInitScript` capturing the URL (assert it starts with the pickerUri). Tests: `gphotos: happy path — open picker, poll, select, import → figure inserted`; `gphotos: cancel before picking resolves [] and deletes the session` (assert `DELETE sessions/sess-1` requested — mock it); `gphotos: session expiry shows retry` (poll returns 410/expired → expired copy visible); `gphotos: video mode imports through /video` (+Video → photos → video item → video node asserted like existing video e2e); `gphotos: hostile filename renders as inert text`.
- [ ] **Step 2: Run to verify they fail**

  Run: `npx playwright test --config test/playwright.config.ts -g "gphotos:"`
  Expected: FAIL (no such source button / no module).
- [ ] **Step 3: Implement** `gphotos.ts`, source-picker choice, inserters wiring.
- [ ] **Step 4: Run to verify they pass**

  Run: same `-g "gphotos:"` command after `npm run build:admin`, then `-g "gdrive:|onedrive:"` for regressions.
  Expected: all PASS.
- [ ] **Step 5: Commit**

```bash
git add src/admin/integrations/gphotos.ts src/admin/source-picker.ts src/admin/image-insert.ts src/admin/video-insert.ts test/e2e/editor-flow.spec.ts
git commit -m "photos: session picking dialog and source entry"
```

### Task 5: Docs + full gates

**Files:**
- Modify: `docs/spec.md` (provider table: add `Google Photos | Picker-API session + Library download | OAuth2` row), `docs/RUNBOOK.md` (first-deploy step 1: enable **Google Photos Picker API** in the shared project; add the three `.../gphotos/callback` redirect URIs to the Google list), `docs/DEFERRED.md` (nothing — skip unless the build surfaces some)

**Model:** `haiku` — doc edits plus running the standard gates.

- [ ] **Step 1: Apply the doc edits.**
- [ ] **Step 2: Run the full verification set**

  Run: `npm test 2>&1 | tail -8` (expect `fail 0`), then `npx tsc --noEmit` (exit 0), then `npx tsc -p tsconfig.e2e.json --noEmit` (exit 0), then `npx biome check src/ test/lib/photos-picker.test.ts test/routes/integrations-gphotos.test.ts test/templates/admin-settings.test.ts test/routes/admin-settings.test.ts` (clean).
  Expected: green everywhere; note counts for the report.
- [ ] **Step 3: Commit**

```bash
git add docs/spec.md docs/RUNBOOK.md
git commit -m "docs: google photos picking"
```

### Task 6: Final review (no deploy)

**Model:** `opus` — whole-branch review is the highest-stakes read; do NOT merge or deploy.

- [ ] **Step 1: Review the branch diff** from the drive-browser HEAD the plan started on through this plan's head, against this plan + `docs/spec.md`: every picked photo/video must reach the editor as an id; cancel/timeout/expire must resolve `[]`; `downloadUrl`/`baseUrl` must never reach the browser (grep the diff); bearer tokens stay on `photospicker.googleapis.com`; hostile names inert.
- [ ] **Step 2: Report verdict** (SHIP / SHIP_WITH_FIXES / BLOCKED) with file:line references. Then STOP — deployment stays with the session owner.

## Self-Review

1. Spec coverage: Photos row → Task 5; lib → Task 1; routes+OAuth → Task 2; settings → Task 3; dialog+source entry → Task 4; review → Task 6. The `gphotosConfigured` gate mirrors the proven gdrive pattern (Task 2).
2. Step scan: each step names exact endpoints, names, commands, expected outputs. Fixed inline while drafting.
3. Type consistency: `PickedItem.kind` ↔ `MediaKind` mapping owned by Task 1; `nextPageToken` naming consistent Tasks 1/2; `pickFromPhotos(): Promise<string[]>` matches sibling signatures for Task 4 inserters.
4. Review Focus: all five items pinned to Tasks 2/4 above.
5. Proportion: endpoints and test assertions dominate, as they carry the decisions; no implementation bodies transcribed.
