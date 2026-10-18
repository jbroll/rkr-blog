# Video Source Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `+Video` offers Local / Drive / OneDrive via the same source-picker as `+Image`.

**Architecture:** Keep image import paths untouched; add parallel `*/video` import endpoints using `ingestVideoStream` + `renderVideoDerivative`; add video-mode pickers on the client; wire `createVideoInserter` through the shared `#rkr-source-picker` dialog.

**Tech Stack:** Fastify + TypeScript, Google Picker SDK, OneDrive Graph wrapper, ffprobe ingest (`src/lib/video.ts`), TipTap editor.

**Spec:** User request: video chooser must allow same options as image chooser (Local + Drive + OneDrive), not just system file dialog.

## Global Constraints

- TypeScript strict; biome lint must pass.
- `src/templates/admin.ts` stays under size discipline; prefer minimal edits.
- Image import endpoints keep 415 on non-`image/*`; do not change existing image behavior.
- Video caps come from `resolveVideoCaps(siteRoot)` with fallback to `DEFAULT_VIDEO_CAPS`.
- All cloud video ingests write sidecar `source.kind: 'gdrive' | 'onedrive'` (already in `VideoSidecar` union).

## Review Focus

- 2GB Drive video picked → expect clean 413/415 status, not hung picker.
- Drive file with `video/*` mime but corrupt bytes → expect 422 probe error surfaced in `#rkroll-admin-status`.
- OneDrive folder with mixed images + videos in video mode → expect only videos + folders listed.
- Cancel at source-picker / Drive CANCEL / OneDrive Cancel → expect `[]`, no insert, no status error.
- e2e `setInputFiles` on `#rkr-video-input` bypassing picker → expect legacy direct upload still works.

---

### Task 1: Server video cloud-import endpoints

**Files:**
- Modify: `src/routes/integrations-gdrive.ts`
- Modify: `src/routes/integrations-onedrive.ts`
- Modify: `src/routes/integrations-shared.ts`
- Test: `test/routes/integrations-gdrive.test.ts`
- Test: `test/routes/integrations-onedrive.test.ts`

**Model:** `sonnet` — multi-file route coordination, streaming + caps judgment.

**Interfaces:**
- Consumes: `ingestVideoStream(args: IngestVideoArgs) -> IngestVideoResult`, `renderVideoDerivative({originalId, ops, posterTimeMs, siteRoot})`, `videoCachePaths(siteRoot, id, [], posterTimeMs)`, `resolveVideoCaps(siteRoot)`, existing `fetchDriveFile`, `fetchOneDriveFile`.
- Produces: `POST /admin/import/gdrive/video -> {id, bytes, ext, deduplicated, videoUrl, posterUrl}`, `POST /admin/import/onedrive/video -> same shape`.

- [ ] **Step 1: Write failing route tests**

```ts
// test/routes/integrations-gdrive.test.ts
test('POST /admin/import/gdrive/video ingests video/* via ingestVideoStream', async (t) => {
  // stub driveFetcher returns video/mp4 bytes; expect 200 + id match /^[0-9a-f]{64}$/
});
test('POST /admin/import/gdrive/video 415s on non-video content-type', async (t) => {
  // stub returns image/png; expect 415
});
```

Same two tests for onedrive in `test/routes/integrations-onedrive.test.ts`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/routes/integrations-gdrive.test.ts -t "gdrive/video"`
Expected: FAIL with 404 (route not defined).

- [ ] **Step 3: Implement `POST /admin/import/gdrive/video` in `src/routes/integrations-gdrive.ts`**

Mirror existing `/admin/import/gdrive` handler but: accept `video/*` only (else 415), pipe through byte-cap `Transform` (use `REMOTE_IMPORT_MAX_BYTES` as pre-cap, then `ingestVideoStream` enforces `resolveVideoCaps`), `source: {kind: 'gdrive', originalName: drive.file.name}`, then `renderVideoDerivative` + return `{id, bytes, ext, deduplicated, videoUrl, posterUrl}`. Map `VideoCapError -> 413`, `VideoProbeError -> 422`.

- [ ] **Step 4: Implement `POST /admin/import/onedrive/video` in `src/routes/integrations-onedrive.ts`**

Same as Step 3 with `kind: 'onedrive'` and `fetchOneDriveFile`.

- [ ] **Step 5: Run route tests to verify they pass**

Run: `npm test -- test/routes/integrations-gdrive.test.ts test/routes/integrations-onedrive.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/integrations-gdrive.ts src/routes/integrations-onedrive.ts test/routes/integrations-gdrive.test.ts test/routes/integrations-onedrive.test.ts
git commit -m "feat: add drive/onedrive video import endpoints"
```

### Task 2: Client cloud pickers with video mode

**Files:**
- Modify: `src/admin/integrations/gdrive.ts`
- Modify: `src/admin/integrations/onedrive.ts`
- Modify: `src/lib/microsoft-graph.ts`
- Modify: `src/admin/integrations/provider-helpers.ts`
- Test: `test/unit/video-picker-mode.test.ts` (new, pure filter/ViewId logic if extractable; else e2e-mocked fetch test)

**Model:** `sonnet` — Picker SDK + Graph filter judgment across files.

**Interfaces:**
- Consumes: `POST /admin/import/gdrive/video`, `POST /admin/import/onedrive/video`.
- Produces: `pickFromDriveVideo() -> Promise<string[]>`, `pickFromOneDriveVideo() -> Promise<string[]>`, `importCloudVideo(importUrl, fileId) -> Promise<VideoUploadResponse>`, `listOneDriveFolder(token, folderId, {kind: 'video'})`.

- [ ] **Step 1: Write the failing test**

```ts
test('listOneDriveFolder video mode keeps video/* + folders, drops images', async () => {
  // stub fetcher returns folder + image/png + video/mp4; kind:'video' -> only folder + video
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/unit/video-picker-mode.test.ts`
Expected: FAIL with "kind not supported / function not defined".

- [ ] **Step 3: Implement `importCloudVideo(url, fileId)` in `src/admin/integrations/provider-helpers.ts`**

Signature `export async function importCloudVideo(importUrl: string, fileId: string): Promise<VideoUploadResponse>` (import type from `../video-upload.ts`). Same body as `importCloudFile`.

- [ ] **Step 4: Implement video pickers**

In `src/admin/integrations/gdrive.ts`: extract shared `pickFromDriveInternal(viewId)`, keep `pickFromDrive()` on `DOCS_IMAGES`, add `pickFromDriveVideo()` using video view (`picker.ViewId.DOCS_VIDEOS` with fallback to filtered `DocsView` accepting `video/*`) + `importCloudVideo('/admin/import/gdrive/video', doc.id)`. Status copy: `importing <name> from Drive…` / `imported …`.
In `src/admin/integrations/onedrive.ts`: add `pickFromOneDriveVideo()` threading `mediaKind: 'video'` through `openOneDriveBrowser(opts)`; empty-state copy `No videos or folders here.`, import status `imported N video(s) from OneDrive`, import via `/admin/import/onedrive/video`. Keep `pickFromOneDrive()` defaulting to image mode.
In `src/lib/microsoft-graph.ts`: add `opts.kind?: 'image' | 'video'` to `listOneDriveFolder`, filter `image/*` vs `video/*` accordingly (default `'image'` preserves current behavior).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- test/unit/video-picker-mode.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/admin/integrations/gdrive.ts src/admin/integrations/onedrive.ts src/lib/microsoft-graph.ts src/admin/integrations/provider-helpers.ts test/unit/video-picker-mode.test.ts
git commit -m "feat: add video-mode drive/onedrive pickers"
```

### Task 3: Wire +Video through the source picker

**Files:**
- Modify: `src/admin/video-insert.ts`
- Modify: `src/admin/main.ts`
- Modify: `src/templates/admin.ts`
- Test: `test/e2e/video-upload.spec.ts` (extend toolbar test with source-picker local branch)

**Model:** `sonnet` — editor wiring + dialog reuse judgment.

**Interfaces:**
- Consumes: `pickFromDriveVideo()`, `pickFromOneDriveVideo()`, `uploadVideo(file)`, `sourceDialog: HTMLDialogElement`.
- Produces: `createVideoInserter({editor, fileInput, sourceDialog})` with `insertNew(): Promise<void>` opening picker first.

- [ ] **Step 1: Write the failing e2e/unit test**

```ts
test('video: toolbar +Video shows source picker, Local branch uploads', async ({ page }) => {
  await page.getByRole('button', { name: '+Video' }).click();
  await expect(page.locator('#rkr-source-picker')).toBeVisible();
  await page.locator('#rkr-source-picker button[data-source="local"]').click();
  await page.locator('#rkr-video-input').setInputFiles({ name: 'toolbar.mp4', mimeType: 'video/mp4', buffer: makeFixtureMp4() });
  await expect(page.locator('.rkr-video-placeholder[data-video]')).toHaveCount(1, { timeout: 60_000 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test test/e2e/video-upload.spec.ts -g "source picker"`
Expected: FAIL (dialog never visible; direct `.click()` on file input).

- [ ] **Step 3: Implement `createVideoInserter` source-picker branch in `src/admin/video-insert.ts`**

Change `VideoInserterDeps` to `{editor, fileInput, sourceDialog}`. Add local `openSourcePicker(dialog)` (same `data-source` click → `local|drive|onedrive|null` contract as image-insert) + `insertFromAnySource()`: `local -> fileInput.click()`, `drive -> pickFromDriveVideo()`, `onedrive -> pickFromOneDriveVideo()`, then `insertVideoFile` per returned id via `editor.chain().focus().insertContent({type:'video', attrs:{ids}})`. To insert by id without re-upload, add internal `insertVideoId(id: string)`. Keep `handleFileChange()` for local files unchanged. Set dialog title dynamically: before `openModal`, set `#rkr-source-picker-title` text to `Add video`.

- [ ] **Step 4: Update wiring in `src/admin/main.ts:113-114` and dialog title in `src/templates/admin.ts:199-200`**

Replace `createVideoInserter({editor, fileInput: videoInput})` with `{editor, fileInput: videoInput, sourceDialog}`. Change comment to `Video uses the shared source picker in video mode`. In `admin.ts`, change `<h2>Add image</h2>` handling: keep static `Add media` or leave `Add image` since JS retitles per open (image branch sets `Add image`, video sets `Add video`). Implement retitle in both `image-insert.ts` and `video-insert.ts` open paths.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx playwright test test/e2e/video-upload.spec.ts test/e2e/editor-flow.spec.ts -g "Video|source"`
Expected: PASS (legacy `setInputFiles`-without-picker path in existing toolbar test still passes because `handleFileChange` defaults work).

- [ ] **Step 6: Commit**

```bash
git add src/admin/video-insert.ts src/admin/main.ts src/templates/admin.ts test/e2e/video-upload.spec.ts
git commit -m "feat: route +Video through source picker with drive/onedrive"
```
