# Server-Driven Google Drive Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Google Picker SDK flow (which 401s in the browser with a proven-valid token) with a server-driven Drive file browser that reuses the OneDrive browser dialog, keeping `pickFromDrive()` / `pickFromDriveVideo()` signatures unchanged.

**Architecture:** New `listDriveFolder` lib function (Drive `files.list`) + new `GET /admin/integrations/gdrive/files` route mirror the OneDrive server side; the OneDrive client dialog is extracted into a provider-parameterized `provider-browser.ts` with thin OneDrive and Drive adapters; the gapi/SDK code in `gdrive.ts` is deleted; CSS classes go provider-neutral.

**Tech Stack:** TypeScript + Fastify (server), vanilla DOM + `<dialog>` (admin client), node:test, Playwright (chromium, self-booting webServer).

**Spec:** `docs/spec.md` line 490 (Drive row: Picker API + Drive v3 `drive.readonly`) — Task 5 updates it to the server-driven browser. This plan argues from the existing OneDrive implementation (`src/routes/integrations-onedrive.ts` files/thumbnail/import routes, `src/admin/integrations/onedrive.ts` dialog) as the reference both sides mirror.

## Global Constraints

- ES modules, kebab-case filenames, no top-level side effects (`docs/developer-quickstart.md` §4).
- `npx biome check` clean on every touched file.
- `npx tsc --noEmit` clean (server config covers `src/**` + `test/**` except the e2e/DOM-excluded list; `test/admin/**` is typechecked via `tsconfig.e2e.json`).
- c8 per-file gates: lines 90, branches 75, functions 90 on `src/**` — every new function needs real tests.
- Production sources (`src/`, `bin/`) under the 500-line cap; tests exempt.
- Every `export` must be imported somewhere (knip `ts-deadcode` gate fails unused exports).
- TDD: failing test first, watched fail, minimal implementation. Never fix two things in one task.

## Review Focus

1. Drive folder with >50 items — `pageToken` must round-trip through the client cursor into Load more; test pins it in the task owning the client (Task 4 e2e: two-page fixture, click Load more, second page renders).
2. Hostile file/folder names (`<img src=x onerror=alert(1)>`, quotes) — names render via `textContent` only and execute nothing; test pins it in Task 4 e2e (malicious name in fixture, assert literal text present and no dialog breakage).
3. `kind=video` over an image-only folder — filtered page is empty with no cursor: dialog shows the video empty-state copy, no hang; test pins it in Task 4 e2e.
4. Bogus `folderId` (attacker or stale crumb) — route 400s JSON, dialog shows the error placeholder and stays open; test pins it in Task 2 route test (400 + error match) — dialog path already covered by Task 4 files-error e2e.
5. Token gone mid-browse (disconnect in another tab / expiry with no refresh token) — route 412/404 JSON surfaces as dialog error text, never a hang; tests pin it in Task 2 route tests (412 when unconnected).

---

### Task 1: `listDriveFolder` lib + unit tests

**Files:**
- Modify: `src/lib/google-drive.ts`
- Test: `test/lib/google-drive.test.ts`

**Model:** `sonnet` — Drive `files.list` query-syntax judgment plus repo stub conventions.

**Interfaces:**
- Consumes: `assertSafeFetchUrl`, `UnsafeUrlError` from `src/lib/url-safety.ts` (already imported in file).
- Produces: `listDriveFolder(accessToken: string, folderId: string, opts?: { fetcher?: typeof fetch; pageToken?: string; kind?: 'image' | 'video' }) => Promise<{ items: DriveBrowseItem[]; nextPageToken: string | null }>` where `DriveBrowseItem = { id: string; name: string; type: 'file' | 'folder'; mimeType?: string; thumbnailUrl?: string }`.

- [ ] **Step 1: Write failing tests** in `test/lib/google-drive.test.ts` (follow the file's `fixedFetcher` pattern; stub matches on `drive/v3/files?` + `q=`):
  - `listDriveFolder image mode keeps image files + folders, drops videos`: fixture children `[photo.jpg image/jpeg, clip.mp4 video/mp4, Photos folder-mime]` → returns photo + Photos, `type` correct, folder has no `mimeType` requirement.
  - `listDriveFolder video mode keeps video files + folders, drops images`.
  - `listDriveFolder passes pageToken and surfaces nextPageToken`: stub asserts `pageToken=` present in outgoing URL; returns `nextPageToken: 'tok2'`; assert surfaced verbatim, `null` when absent.
  - `listDriveFolder queries the given folder and excludes trashed`: stub asserts URL contains `'folder-9' in parents` and `trashed = false`; folderId `'root'` produces `'root' in parents`.
  - `listDriveFolder surfaces thumbnailLink as thumbnailUrl`.
  - `listDriveFolder throws on HTTP error`: stub 500 → rejects `/drive list: HTTP 500/`.
- [ ] **Step 2: Run to verify they fail**

  Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types --conditions=development test/lib/google-drive.test.ts`
  Expected: new tests FAIL (function not defined).
- [ ] **Step 3: Implement `listDriveFolder`** in `src/lib/google-drive.ts`: `GET https://www.googleapis.com/drive/v3/files` with `q='${folderId}' in parents and trashed = false and (mimeType contains '<image|video>/' or mimeType = 'application/vnd.google-apps.folder')`, `fields=files(id,name,mimeType,thumbnailLink),nextPageToken`, `pageSize=50`, `orderBy=modifiedTime desc`, plus `pageToken` when provided; bearer auth header; folders-first stable sort (same comparator shape as OneDrive's); non-OK → `drive list: HTTP <status>`.
- [ ] **Step 4: Run tests to verify they pass**

  Run: same command as Step 2.
  Expected: PASS, whole file green.
- [ ] **Step 5: Commit**

```bash
git add src/lib/google-drive.ts test/lib/google-drive.test.ts
git commit -m "drive: add listDriveFolder for server-driven browsing"
```

### Task 2: `GET /admin/integrations/gdrive/files` route + tests

**Files:**
- Modify: `src/routes/integrations-gdrive.ts`
- Test: `test/routes/integrations-gdrive.test.ts` (reuse its `setup()` + stub exchange)

**Model:** `sonnet` — mirrors the OneDrive `/files` route shape and guard choice.

**Interfaces:**
- Consumes: Task 1 `listDriveFolder`.
- Produces: route `GET /admin/integrations/gdrive/files` with `requireUser` guard (NOT owner — mirrors OneDrive `/files`, which editor-role users may browse); query `{ folderId?: string; pageToken?: string; kind?: string }`; response `{ items: [{ id, name, type, mimeType?, thumbnailUrl? }], nextPageToken: string | null }`; `kind=video` ⟺ video filter else image; missing/unconnected token → 412 `{ error: 'gdrive not connected' }` (mirrors OneDrive's 404-vs-412 choice: OneDrive `/files` uses 404 when unconnected — read `src/routes/integrations-onedrive.ts:302-334` and match its status code exactly, whichever it is).

- [ ] **Step 1: Write failing tests** (follow the file's `setup()`; stub Drive API via `gdrive: { exchange, driveFetcher }` like the existing `stubDriveFetcher`, matching on `drive/v3/files?` without `alt=media`):
  - `GET /files lists image files + folders for the owner`: fixture `files[]` with one image, one video, one folder + `nextPageToken: 'p2'` → 200, video excluded, `nextPageToken` surfaced.
  - `GET /files?kind=video filters to videos`: stub asserts outgoing `q` contains `video/`; image excluded.
  - `GET /files forwards pageToken`: stub asserts `pageToken=p2` in outgoing URL.
  - `GET /files 412s when unconnected` (or the OneDrive-mirrored code from the Interfaces block): fresh user with no token row → that exact status + error match.
  - `GET /files 400s on Drive API error`: stub 403 → 400 with error body.
  - `GET /files admits an editor role` (requireUser, not owner): build per `owner-guard.test.ts` editor setup or reuse pattern from OneDrive files tests — read `test/routes/integrations-onedrive.test.ts` files-route tests and mirror the auth setup exactly.
- [ ] **Step 2: Run to verify they fail**

  Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types --conditions=development test/routes/integrations-gdrive.test.ts`
  Expected: new tests FAIL with 404 (no route).
- [ ] **Step 3: Implement the route** in `src/routes/integrations-gdrive.ts` next to the existing integration routes; import `listDriveFolder` from `../lib/google-drive.ts`; pass `opts.driveFetcher` through like `fetchDriveFile` does.
- [ ] **Step 4: Run tests to verify they pass**

  Run: same command as Step 2.
  Expected: PASS, whole file green.
- [ ] **Step 5: Commit**

```bash
git add src/routes/integrations-gdrive.ts test/routes/integrations-gdrive.test.ts
git commit -m "drive: add /admin/integrations/gdrive/files listing route"
```

### Task 3: Shared `provider-browser.ts` + OneDrive adapter (no behavior change) + neutral CSS

**Files:**
- Create: `src/admin/integrations/provider-browser.ts`
- Modify: `src/admin/integrations/onedrive.ts` (thin adapter only — delete dialog code, keep URL shapes byte-identical)
- Modify: `src/templates/admin-styles-dialogs.ts` (rename `rkr-od-` → `rkr-cb-`, `#rkr-onedrive-browser` → `#rkr-cloud-browser`, comment `OneDrive file browser modal` → `Cloud file browser modal`)
- Modify: `test/templates/admin-styles.fixture.css` (same renames only — the split test asserts byte-identity, so rename by `sed`, never by hand-editing rules)
- Modify: `test/e2e/editor-flow.spec.ts` (onedrive selectors only: `#rkr-onedrive-browser` → `#rkr-cloud-browser`, `rkr-od-` → `rkr-cb-`; no behavior changes)
- Test: e2e onedrive block + `test/templates/admin-styles-split.test.ts`

**Model:** `sonnet` — multi-file move with byte-identical styling and selector updates.

**Interfaces:**
- Consumes: `openModal` from `../dialog-focus.ts`, `setStatus` from `../dom.ts`, `ensureConnected`/`importCloudFile`/`importCloudVideo` from `./provider-helpers.ts`.
- Produces: `CloudBrowseItem { id: string; name: string; type: 'file' | 'folder'; mimeType?: string; thumbnailUrl?: string }`, `CloudFilesPage { items: CloudBrowseItem[]; cursor: string | null }`, `MediaKind = 'image' | 'video'`, `CloudBrowserConfig { providerName: string; dialogTitle: string; rootName: string; statusUrl: string; connectUrl: string; emptyCopy: string; emptyVideoCopy: string; importNoun: string; listPage: (folderId: string, cursor: string | null, kind: MediaKind) => Promise<CloudFilesPage>; fetchThumbnailUrl: ((itemId: string) => Promise<string | null>) | null; importFile: (fileId: string) => Promise<{ id: string; bytes: number }>; importVideo: (fileId: string) => Promise<{ id: string }> }`, `pickFromCloudProvider(config: CloudBrowserConfig, mediaKind: MediaKind): Promise<string[]>`. Every export is used by both adapters (knip gate).

- [ ] **Step 1: Create `provider-browser.ts`** by moving the dialog from `onedrive.ts` verbatim, parameterized: dialog id `rkr-cloud-browser`, classes `rkr-cb-*`, `fetchThumbnailUrl` null-gated (when null and `item.thumbnailUrl` present, render `<img src>` directly with `alt=""`; else placeholder icon); thumbnail endpoint calls go through `config.fetchThumbnailUrl`. Rewrite `onedrive.ts` to export identical `pickFromOneDrive` / `pickFromOneDriveVideo` signatures delegating with `cursor: nextLink` mapping and the `/thumbnail` fetcher. Apply the CSS + fixture renames via `sed -i 's/rkr-od-/rkr-cb-/g; s/rkr-onedrive-browser/rkr-cloud-browser/g'` on the two CSS files only. Update onedrive e2e selectors the same way.
- [ ] **Step 2: Run the split test + typecheck to verify nothing drifted**

  Run: `node --test --no-warnings=ExperimentalWarning --experimental-strip-types --conditions=development test/templates/admin-styles-split.test.ts && npx tsc -p tsconfig.e2e.json --noEmit`
  Expected: PASS (byte-identity holds; DOM files typecheck). Note: `npm run typecheck` covers browser config too; the e2e-config check is the faster targeted one.
- [ ] **Step 3: Run the OneDrive e2e block to verify zero behavior change**

  Run: `npx playwright test --config test/playwright.config.ts -g "onedrive:"`
  Expected: all onedrive tests PASS against the self-booted server.
- [ ] **Step 4: Commit**

```bash
git add src/admin/integrations/provider-browser.ts src/admin/integrations/onedrive.ts src/templates/admin-styles-dialogs.ts test/templates/admin-styles.fixture.css test/e2e/editor-flow.spec.ts
git commit -m "browser: extract shared cloud file browser, neutralize CSS"
```

### Task 4: Drive adapter in `gdrive.ts` (delete SDK) + Drive browser e2e

**Files:**
- Modify: `src/admin/integrations/gdrive.ts` (delete gapi/picker loading + `PickerBuilder` shims; `pickFromDrive` / `pickFromDriveVideo` delegate to `pickFromCloudProvider` with Drive endpoints + inline thumbnails)
- Modify: `test/e2e/editor-flow.spec.ts` (delete `GDRIVE_*_SCRIPT` mocks; `setupGdriveRoutes` mocks `/status`, `/files` (root page: folder `folder-001` + image; `folder-001` page: second image; optional `nextPageToken` second page for Load more), `/import/gdrive`; rewrite the five gdrive tests)
- Test: e2e gdrive block

**Model:** `sonnet` — client rewrite plus e2e mock surgery.

**Interfaces:**
- Consumes: Task 3 `pickFromCloudProvider` + config types; Task 2 route shape (`{ items, nextPageToken }` → adapter maps to `{ items, cursor }`); `importCloudFile('/admin/import/gdrive', …)` / `importCloudVideo('/admin/import/gdrive/video', …)` from `provider-helpers.ts` (unchanged).
- Produces: `pickFromDrive(): Promise<string[]>` and `pickFromDriveVideo(): Promise<string[]>` with signatures and resolve-`[]`-on-cancel semantics byte-identical to today (callers `image-insert.ts` / `video-insert.ts` untouched).

- [ ] **Step 1: Rewrite the gdrive e2e block first (failing)**: delete the three `GDRIVE_*_SCRIPT` consts; `setupGdriveRoutes(page, { connected?: boolean; importStatus?: number })` mirroring `setupOneDriveRoutes` but for `/admin/integrations/gdrive/files**` (fixture: root → `[{folder-001 Photos folder}, {gd-img-001 meadow.jpg image/jpeg thumbnailLink data-URI}]`, `folder-001` → `[{gd-img-002 lake.jpg …}]`, plus a `nextPageToken: 'p2'` variant for the Load-more test) and `/admin/import/gdrive` → `{ id: 'ccc333ddd444eee555fff66677788', bytes, ext, deduplicated }`. Tests: `gdrive: happy path — select file + import → figure inserted` (mirror onedrive's, incl. figure-id assertion on the imported id); `gdrive: not connected + dismiss → no dialog opened` (assert `#rkr-cloud-browser` count 0); `gdrive: cancel → no figure inserted` (click `.rkr-cb-cancel`); `gdrive: import error → status shows error` (import 500 → `/Drive import error/`); `gdrive: folder navigation + Load more` (open folder-001, breadcrumb shows Photos, Load more reveals second page); `gdrive: hostile file name renders as text` (fixture name `<img src=x onerror=window.__rkrXss=1>`, assert literal text visible and `window.__rkrXss` undefined); `gdrive: video mode over images shows video empty state` (call `pickFromDriveVideo` path — mirror however onedrive's video e2e reaches it; if onedrive has no video-mode e2e, drive the source picker via the +Video button the same way `video-upload.spec.ts` does and assert `/No videos or folders here./`).
- [ ] **Step 2: Run to verify they fail**

  Run: `npx playwright test --config test/playwright.config.ts -g "gdrive:"`
  Expected: FAIL (old SDK code calls missing mocks / new dialog absent).
- [ ] **Step 3: Implement the `gdrive.ts` rewrite**: delete `GAPI_SRC`, `loadGapi`, `loadPicker`, picker interfaces/mocks surface, `GdrivePickerConfig`; `pickFromDriveInternal` becomes config + `pickFromCloudProvider(config, kind)` with `fetchThumbnailUrl: null` (inline `thumbnailUrl`), `rootName/dialogTitle: 'Google Drive'`, `importNoun: 'image'`, empty copies matching OneDrive's wording with provider-appropriate nouns. Keep `ensureConnected('Google Drive', …/status, …/connect)` prompt text identical.
- [ ] **Step 4: Run to verify they pass**

  Run: same `-g "gdrive:"` command, then `-g "onedrive:"` to confirm no regression.
  Expected: both blocks PASS.
- [ ] **Step 5: Commit**

```bash
git add src/admin/integrations/gdrive.ts test/e2e/editor-flow.spec.ts
git commit -m "drive: browse via shared cloud dialog, drop Picker SDK"
```

### Task 5: Docs + full gates

**Files:**
- Modify: `docs/spec.md` (Drive row ~line 490: Picker API → server-driven browser), `docs/DEFERRED.md` (one line: remove now-unused `GET /admin/integrations/gdrive/picker-config`, revisit when no client references it)

**Model:** `haiku` — doc edits plus running the standard gates.

- [ ] **Step 1: Apply the two doc edits.**
- [ ] **Step 2: Run the full verification set**

  Run: `npm test 2>&1 | tail -8` (expect `fail 0`), then `npx tsc --noEmit` (exit 0), then `npx biome check src/ test/e2e/editor-flow.spec.ts` (no fixes).
  Expected: 0 failures everywhere; note the counts in the commit message trailer or report.
- [ ] **Step 3: Commit**

```bash
git add docs/spec.md docs/DEFERRED.md
git commit -m "docs: drive browser replaces Picker SDK; note picker-config removal"
```

### Task 6: Final review (no deploy)

**Model:** `opus` — whole-branch review is the highest-stakes read; do NOT merge or deploy.

- [ ] **Step 1: Review the branch diff** (`git log --oneline origin/main..HEAD` for the task commits plus `git diff origin/main...HEAD --stat`) against this plan and `docs/spec.md`: every picked file must reach the editor as an id (happy paths), cancel/empty/error must resolve `[]` without a hang, no bearer token may leave the initial origin on Drive download redirects (see `fetchWithRedirectValidation` precedent in `microsoft-graph.ts`), no `innerHTML` with server/file data anywhere in the new client code.
- [ ] **Step 2: Report verdict** (SHIP / SHIP_WITH_FIXES / BLOCKED) with file:line references. Then STOP — deployment stays with the session owner.

## Self-Review

1. Spec coverage: spec.md:490 Drive row → Task 5 doc edit + Tasks 1/2/4 behavior. Callers (`image-insert`, `video-insert`) untouched by signature preservation (Tasks 3/4 interfaces). Owner/editor gating → Task 2 (requireUser mirror) + existing owner-guard suite (no new owner-only route added, so no table change needed).
2. Step scan: each step names exact files, names, commands, expected outputs. Fixed inline while drafting.
3. Type consistency: `CloudFilesPage.cursor` ↔ adapters map onedrive `nextLink` / gdrive `nextPageToken`; `pickFromDrive(): Promise<string[]>` unchanged; `DriveBrowseItem.thumbnailUrl` ← `thumbnailLink`; CSS `rkr-cb-*` + `#rkr-cloud-browser` used consistently in Task 3/4 and e2e selectors.
4. Review Focus: all five items pinned to Tasks 2/4 above.
5. Proportion: plan is longer than the ~500 new lines it describes, but the excess is test assertions and exact shell commands the implementers cannot derive — acceptable per the step-content rule.
