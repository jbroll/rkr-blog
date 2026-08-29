# Self-hosted video v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver isolated `::video{id="..."} ` widget: hash-addressed originals in `originals/videos`, JSON sidecar with trim op, single ffmpeg transcode to h264/aac mp4 + jpeg poster in `cache/video`, range-capable `GET /video/...` with 202+retry, admin upload.

**Architecture:** New `VideoMap`/`VideoSidecar`/`video-ffmpeg`/`video-render` modules parallel image pipeline but never touch `figure.ts`/`lightbox`. `renderVideoDerivative` does atomic ffmpeg + poster, `public-video.ts` serves hits with Range/206 and misses with budget+202 dedup. Widget emits `<figure class="rkr-video"><video poster ...>` with CSS aspect reservation.

**Tech Stack:** Node 22, Fastify + @fastify/multipart, ffmpeg/ffprobe via spawn, sharp only for image path, vitest node:test, Playwright e2e. TypeScript ESM.

## Global Constraints

- Self-hosted single transcode only: one normalized mp4 (h264/aac, yuv420p, +faststart, max 1920w, preset fast CRF23) + one jpeg poster (640w equivalent).
- Non-destructive trim only: `ops: [{kind:"trim",startMs,endMs}]` + redoStack, original never rewritten.
- Isolated v1: do not edit `src/widgets/figure.ts`, `src/lib/image-map-fs.ts`, `src/lib/image-map-opfs.ts`, `src/lib/image-map.ts`, `src/lib/lightbox.ts`; new `VideoMap` owns video.
- Hash-addressed originals: sha256 hex id, `originals/videos/<aa>/<bb>/<id>.<ext>` dedup via atomic tmp+rename.
- Sidecar at `sidecars/videos/<id>.json`, version 1, atomic write + validation.
- Cache key via `src/lib/hash.ts:cacheKey`, `cache/video/<id>.<ophash>.mp4` + `.jpg` poster, immutable cache header.
- No HLS/DASH, no adaptive renditions, no mixed figure galleries, no FTS indexing of video, no GC on post delete.
- Pre-commit hook runs biome/tsc/duplicate-types/no-reexports/knip/circular/size/c8. Keep prod files <500 lines.

---

### Task 1: Paths, site caps, Apache rewrite

**Files:**
- Modify: `src/lib/config.ts:218-234`
- Modify: `fly-deploy/apache.conf:20-24`
- Modify: `docs/theming.md` (add stable hook docs later, but create placeholder if needed — not this task)
- Test: `test/lib/config-video-paths.test.ts`

**Interfaces:**
- Consumes: existing `paths()` and `siteRoot()`.
- Produces: `Paths.originalsVideo: string`, `Paths.sidecarsVideo: string`, `Paths.cacheVideo: string`, optional `SiteConfig.videoCaps?: {maxBytes,maxDurationMs,maxWidth}` (defaults 500MiB/300s/1920w-7680 cap), `VIDEO_CAPS_BOUNDS` constants.

- [ ] **Step 1: Write failing test for new paths**

```ts
// test/lib/config-video-paths.test.ts
import { describe, it, expect } from 'vitest';
import { paths } from '../../src/lib/config.ts';
describe('video paths', () => {
  it('exposes originalsVideo/sidecarsVideo/cacheVideo under site root', () => {
    const p = paths({ SITE_ROOT: '/tmp/site' } as any);
    expect(p.originalsVideo).toBe('/tmp/site/originals/videos');
    expect(p.sidecarsVideo).toBe('/tmp/site/sidecars/videos');
    expect(p.cacheVideo).toBe('/tmp/site/cache/video');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/lib/config-video-paths.test.ts`
Expected: FAIL — property missing

- [ ] **Step 3: Implement paths + videoCaps**

In `src/lib/config.ts`:
- Extend `Paths` with `originalsVideo`, `sidecarsVideo`, `cacheVideo`.
- In `paths()` return them as `path.join(root,'originals','videos')` etc.
- Add `VideoCaps` interface and `VIDEO_CAPS_BOUNDS = {maxBytes:{min:1,max:2*1024*1024*1024}, maxDurationMs:{min:1000,max:600000}, maxWidth:{min:320,max:7680}}`.
- Add `videoCaps?: VideoCaps` to `PersistedSiteConfig`/`SiteConfig`, parse via `pickPersistedFields` + `pickPersistedVideoCaps` mirroring `pickPersistedIngestResize` (clamp + drop non-numeric).
- Add `DEFAULT_VIDEO_CAPS = {maxBytes: 500*1024*1024, maxDurationMs: 300_000, maxWidth: 1920}` and export `resolveVideoCaps(siteRoot)` helper reading persisted file.

In `fly-deploy/apache.conf`:
- Add after img rewrite:
```
RewriteCond %{DOCUMENT_ROOT}/cache%{REQUEST_URI} -f
RewriteRule ^/video/([0-9a-f]+\.[0-9a-f]+\.mp4)$ /cache/video/$1 [L]
RewriteCond %{DOCUMENT_ROOT}/cache%{REQUEST_URI} -f
RewriteRule ^/video/poster/([0-9a-f]+\.[0-9a-f]+\.jpg)$ /cache/video/$1 [L]
```
And extend `<LocationMatch "^/(cache|static)/">` already covers `/cache/video`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/lib/config-video-paths.test.ts` Expected: PASS
Run: `npx tsc --noEmit` Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/lib/config.ts fly-deploy/apache.conf test/lib/config-video-paths.test.ts
git commit -m "feat(video): add video paths, caps, apache cache fast path"
```

---

### Task 2: Video sidecar types + read/write/validate

**Files:**
- Create: `src/lib/video-sidecar.ts`
- Modify: `packages/image-edit/src/core/sidecar-types.ts` (add VideoSidecar types) OR keep video types only in src/lib/video-sidecar.ts — choose isolated approach to avoid touching image-edit package build; add types to `src/lib/video-sidecar.ts` and re-export.
- Test: `test/lib/video-sidecar.test.ts`

**Interfaces:**
- Consumes: `paths().sidecarsVideo` (Task 1).
- Produces: `VideoSidecar`, `VideoOp {kind:"trim", startMs,endMs}`, `readVideoSidecar(siteRoot,id)`, `writeVideoSidecar(siteRoot,id,data)`, `validateVideoSidecar(data)`, `videoSidecarPath(siteRoot,id)`, `CURRENT_VIDEO_SIDE_VERSION=1`.

- [ ] **Step 1: Write failing test**

```ts
// test/lib/video-sidecar.test.ts
import { describe, it, expect } from 'vitest';
import { validateVideoSidecar } from '../../src/lib/video-sidecar.ts';
describe('video sidecar validate', () => {
  it('accepts minimal valid sidecar', () => {
    const sc = { version:1, original: 'a'.repeat(64), source:{kind:'upload', fetchedAt:new Date().toISOString(), originalName:'a.mp4', storedHash:'b'.repeat(64), uploadFormat:'mp4', uploadBytes:100, uploadWidth:640, uploadHeight:480, durationMs:10000, probe:{codecVideo:'h264', codecAudio:'aac'}}, ops:[], outputs:[{format:'mp4',codec:'h264/aac'}], poster:{timeMs:1000} };
    expect(validateVideoSidecar(sc).ok).toBe(true);
  });
  it('rejects bad version', () => {
    expect(validateVideoSidecar({version:2}).ok).toBe(false);
  });
  it('round-trips write/read', async () => { /* tmp dir, write then read */ });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/lib/video-sidecar.test.ts` Expected: FAIL module missing

- [ ] **Step 3: Implement video-sidecar.ts mirroring src/lib/sidecar.ts**

- Define `VideoSidecar` interface exactly as spec §1.2 (version:1, original sha256, source {kind, fetchedAt, originalName, storedHash, uploadFormat, uploadBytes, uploadWidth, uploadHeight, durationMs, probe:{codecVideo, codecAudio}}, ops: VideoOp[], redoStack?, outputs:[{format:"mp4",codec:"h264/aac",quality?}], poster:{timeMs}).
- Implement `validateVideoSidecar` checking version===1, original SHA256_HEX, source fields types, ops array, poster.timeMs number, outputs length 1.
- Implement `videoSidecarPath(siteRoot,id) => path.join(siteRoot,'sidecars','videos',`${id}.json`)`.
- Implement `readVideoSidecar` (ENOENT -> null, JSON parse) and `writeVideoSidecar` (validate, id match, mkdir sidecars/videos, atomic tmp+rename like sidecar.ts using crypto.randomBytes).
- Add `makeDefaultVideoSidecar(id, sourceMeta): VideoSidecar` helper for ingest.

Do NOT modify packages/image-edit unless needed; if needed add types there but keep src/lib/video-sidecar.ts as canonical.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/lib/video-sidecar.test.ts` Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/video-sidecar.ts test/lib/video-sidecar.test.ts
git commit -m "feat(video): add video sidecar read/write/validate"
```

---

### Task 3: ffmpeg/ffprobe wrapper

**Files:**
- Create: `src/lib/video-ffmpeg.ts`
- Test: `test/lib/video-ffmpeg.test.ts`

**Interfaces:**
- Consumes: node:child_process spawn.
- Produces: `probeVideo(filePath): Promise<{width:number,height:number,durationMs:number,codecVideo:string,codecAudio:string|null,format:string}>`, `transcodeVideo(args): Promise<void>`, `extractPoster(args): Promise<void>` or unified `runFfmpeg(args:string[], opts:{timeoutMs})`, `runFfprobe(args)` with stderr capture, ENOENT actionable error.

- [ ] **Step 1: Write failing test (mocked spawn)**

```ts
import { describe, it, expect, vi } from 'vitest';
import { buildFfmpegArgs } from '../../src/lib/video-ffmpeg.ts';
describe('ffmpeg args', () => {
  it('builds trim+scale mp4 args', () => {
    const args = buildFfmpegArgs({input:'/tmp/in.mp4', output:'/tmp/out.mp4', startMs:2000, endMs:45500, maxWidth:1920});
    expect(args.join(' ')).toContain('-ss 2');
    expect(args.join(' ')).toContain('scale');
    expect(args).toContain('-movflags'); expect(args).toContain('+faststart');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/lib/video-ffmpeg.test.ts` Expected: FAIL

- [ ] **Step 3: Implement src/lib/video-ffmpeg.ts**

- Export `buildFfmpegArgs({input, output, startMs?, endMs?, maxWidth?}) => string[]` producing `['-ss','...','-to','...','-i',input,'-vf',"scale='min(1920,iw)':-2:flags=lanczos",'-c:v','libx264','-preset','fast','-crf','23','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-movflags','+faststart',output]` (omit -ss/-to when no trim; scale uses min(maxWidth,iw)).
- Export `buildPosterArgs({input, timeMs, output}) => ['-ss',String(timeMs/1000),'-i',input,'-vframes','1','-q:v','2',output]`.
- Export `probeVideo(filePath)` spawning `ffprobe -v error -print_format json -show_streams -show_format filePath` with 10s timeout, parsing json, picking first video stream width/height/duration/codec_name, audio codec, format_name, converting duration string*1000.
- Export `runFfmpeg(args, {timeoutMs})` wrapping spawn('ffmpeg', args, {stdio:['ignore','ignore','pipe']}), collecting stderr, timeout kill, ENOENT -> throw `ffmpeg not found; install ffmpeg package`.
- Keep file <200 lines; no sharp import.

- [ ] **Step 4: Run test to verify it passes + probe parsing unit with fixture json**

Run: `npm test -- test/lib/video-ffmpeg.test.ts` Expected: PASS
Run: `npx tsc --noEmit` Expected: clean

- [ ] **Step 5: Commit**

```bash
git add src/lib/video-ffmpeg.ts test/lib/video-ffmpeg.test.ts
git commit -m "feat(video): add ffmpeg/ffprobe wrapper"
```

---

### Task 4: Video ingest (hash, probe, dedup, sidecar)

**Files:**
- Create: `src/lib/video.ts`
- Test: `test/lib/video.test.ts`

**Interfaces:**
- Consumes: `probeVideo` (Task 3), `writeVideoSidecar` (Task 2), `paths().originalsVideo`, `DEFAULT_VIDEO_CAPS`.
- Produces: `ingestVideoStream(args:{stream:Readable, siteRoot:string, source:{kind,originalName,fetchedAt?}, caps?}): Promise<IngestVideoResult{id,path,ext,bytes,deduplicated,sidecar,durationMs,width,height}>`

- [ ] **Step 1: Write failing test**

```ts
// test/lib/video.test.ts — mock probeVideo
it('ingests stream, probes, writes sidecar, dedups second ingest', async () => {
  const tmp = await mkdtemp(...);
  vi.mock('../../src/lib/video-ffmpeg.ts', () => ({ probeVideo: vi.fn(async ()=>[640,480,10000]) }));
  const r1 = await ingestVideoStream({stream:Readable.from(Buffer.from('fake')), siteRoot:tmp, source:{kind:'upload',originalName:'a.mp4'}})
  expect(r1.id).toMatch(/^[0-9a-f]{64}$/)
  const r2 = await ingestVideoStream({stream:Readable.from(Buffer.from('fake')), siteRoot:tmp, source:{kind:'upload',originalName:'a.mp4'}})
  expect(r2.deduplicated).toBe(true)
});
it('rejects over caps', async () => { // caps maxBytes 1, duration probe 400_000 -> 413
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/lib/video.test.ts` Expected: FAIL

- [ ] **Step 3: Implement ingestVideoStream mirroring originals.ts:ingestStream shape**

Steps: pipeline stream -> tmp file via Transform tapping sha256 + bytes; probe via `probeVideo(tmpPath)` (not sha yet? need hash first to reuse tmp); cap checks: bytes>maxBytes => 413 error, durationMs>maxDurationMs, width>7680; dedup check `path.join(siteRoot,'originals','videos',id.slice(0,2),id.slice(2,4),`${id}.${ext}`)` where ext = lowercased probe format (map mov->mp4? keep native ext lowercased); if exists reuse; else mkdir + rename; posterTimeMs = Math.min(1000, Math.floor(durationMs/2)); build sidecar via `makeDefaultVideoSidecar` including probe, write via `writeVideoSidecar`; return.

Handle errors: probe failure => throw `VideoProbeError` (422), cap => `VideoCapError` with status 413.

Export helpers `videoOriginalPath(siteRoot,id,ext)` and `findExistingVideoOriginal(siteRoot,id)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/lib/video.test.ts` Expected: PASS (with mocked probe)
Also test dedup preserves existing sidecar ops.

- [ ] **Step 5: Commit**

```bash
git add src/lib/video.ts test/lib/video.test.ts
git commit -m "feat(video): add ingestVideoStream with dedup and caps"
```

---

### Task 5: Transcode + poster render + VideoMap

**Files:**
- Create: `src/lib/video-render.ts`
- Create: `src/lib/video-map-fs.ts`
- Modify: `src/lib/config.ts` if cacheVideo not exported yet (done)
- Test: `test/lib/video-render.test.ts`, `test/lib/video-map-fs.test.ts`

**Interfaces:**
- Consumes: `cacheKey` (hash.ts), `probeVideo`/`runFfmpeg` (Task 3), `readVideoSidecar` (Task 2), `findExistingVideoOriginal` (Task 4)
- Produces: `renderVideoDerivative({originalId,ops,posterTimeMs,siteRoot,force?}): Promise<{videoPath,posterPath,bytes,cached}>`, `videoDerivativeFilename/VideoPath`, `buildVideoMap(siteRoot): Promise<VideoMap>`, `VideoSource {sidecar,width,height,durationMs,urlFor(ops,posterTimeMs)}`

- [ ] **Step 1: Write failing tests**

```ts
// test/lib/video-render.test.ts
it('hash stable: same ops+poster -> same ophash', () => { expect(cacheKeyForVideo(...)).toBe(...) });
it('trim changes hash', () => { expect(hash({ops:[]})).not.toBe(hash({ops:[{kind:"trim",startMs:0,endMs:1000}]})) });
it('calls ffmpeg with correct args (mocked spawn)', async () => { const spy=vi.spyOn(...); await renderVideoDerivative({...}); expect(spy).toHaveBeenCalledWith(expect.arrayContaining(['-movflags'])) });
```
```ts
// test/lib/video-map-fs.test.ts
it('builds map from sidecars', async () => { await writeVideoSidecar(...); const m = await buildVideoMap(tmp); expect(m.has(id)).toBe(true); });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/lib/video-render.test.ts test/lib/video-map-fs.test.ts` Expected: FAIL

- [ ] **Step 3: Implement video-render.ts**

- Cache filenames: `videoFilename(id,ops,posterIsPoster?)` — video ophash = `cacheKey({originalId:id, ops, variant:{w:1920}, output:{format:"mp4"}})`, poster ophash = `cacheKey({originalId:id, ops, variant:{w:640}, output:{format:"jpg"}})`. Export `videoCachePaths(siteRoot,id,ops,posterTimeMs)`.
- `renderVideoDerivative`: check both `cacheVideo/<id>.<ophash>.mp4` and `.jpg` exist => cached true; else find original via `findExistingVideoOriginal`; if missing throw; clamp posterTimeMs to `[startMs or 0, endMs or durationMs)`; dedup map + Semaphore(1) like render.ts; build ffmpeg args via `buildFfmpegArgs` adding trim if ops has trim; run `runFfmpeg`; then `runFfmpeg(buildPosterArgs)` using transcoded mp4 as input; atomic rename both; concurrency + tmp cleanup like render.ts.
- `derivativePath` helpers.

Implement `video-map-fs.ts`:
- `buildVideoMap(siteRoot): Promise<Map<string,VideoSource>>` scanning `sidecars/videos/*.json`, read sidecar, derive width/height/durationMs from sidecar.source, make `urlFor` that computes ophashes and returns `{videoUrl:`/video/${id}.${oph}.mp4`, posterUrl:`/video/poster/${id}.${ph}.jpg`}`.
- Export `videoDimensions` helper if needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/lib/video-render.test.ts test/lib/video-map-fs.test.ts` Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/video-render.ts src/lib/video-map-fs.ts test/lib/video-render.test.ts test/lib/video-map-fs.test.ts
git commit -m "feat(video): add transcode/poster render and VideoMap"
```

---

### Task 6: Serving (public-video routes + video-retry client)

**Files:**
- Create: `src/routes/public-video.ts`
- Create: `src/site/video-retry.ts`
- Modify: `src/server.ts` or `src/routes/index.ts` where routes registered (wire `registerPublicVideoRoutes`)
- Modify: `src/templates/post.ts` to include video-retry bundle
- Test: `test/routes/public-video.test.ts`

**Interfaces:**
- Consumes: `renderVideoDerivative` (Task 5), `readVideoSidecar` (Task 2), `cacheKey`, `Semaphore`, `enqueue/noteLiveRender`
- Produces: `registerPublicVideoRoutes(fastify, {siteRoot, db, renderBudgetMs})` handling `GET /video/:filename` and `GET /video/poster/:filename` with Range, 202+retry, 404 stale ophash, rateLimit 600/min/IP.

- [ ] **Step 1: Write failing route test**

```ts
// test/routes/public-video.test.ts
it('404 on bad filename', async () => { const res = await app.inject({method:'GET', url:'/video/bad'}); expect(res.statusCode).toBe(404); });
it('202 then 200 after render (mock render)', async () => { /* setup sidecar + stub renderVideoDerivative */ });
it('Range 206', async () => { /* cache hit file exists, request Range: bytes=0-99 */ });
it('404 stale ophash', async () => { /* sidecar ops changed, old ophash 404 */ });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/routes/public-video.test.ts` Expected: FAIL missing route

- [ ] **Step 3: Implement public-video.ts cloning public-img.ts pattern**

- Regex `FILENAME_RE = /^([0-9a-f]{64})\.([0-9a-f]{12})\.(mp4)$/` and `POSTER_RE = /^([0-9a-f]{64})\.([0-9a-f]{12})\.(jpg|jpeg)$/`.
- `findVideoMatch(sidecar, ophash, isPoster)` recomputes cacheKey with correct variant/output and compares.
- Handler: validate filename, read sidecar 404 if missing, findVariantOutput 404 if stale, validate dims (min 16), build `VideoDerivativeArgs`, dedup map `inflightVideoRenders` size 64 -> 503, semaphore, Promise.race with `renderBudgetMs` timeout, on timeout `enqueue(db,{kind:'renderVideo',payload:args,cacheKey:ophash})` + 202 `Retry-After:2`, on success set `Content-Type video/mp4` / `image/jpeg`, `Cache-Control immutable`, `Accept-Ranges bytes`, handle `Range` header parsing to 206/416 streaming via `fs.createReadStream` with start/end.
- `registerPublicVideoRoutes` registers both GETs with `rateLimit: {max:600, timeWindow:'1 minute'}`.
- Wire in `src/server.ts` (find where `registerPublicImgRoutes` is called, add `registerPublicVideoRoutes` with same opts).
- Implement `src/site/video-retry.ts` as clone of `img-retry.ts` but `export function instrumentVideo(video: HTMLVideoElement)` retrying on error for both src and poster: on error schedule retry with same backoff `[500,1500,3000,6000,10000]`, jitter, searchParam `rkr_retry`, visibility handling, MutationObserver detach. Init loops `document.querySelectorAll('video')`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/routes/public-video.test.ts` Expected: PASS
Manual range test: `curl -H "Range: bytes=0-99" http://localhost:3000/video/...` -> 206

- [ ] **Step 5: Commit**

```bash
git add src/routes/public-video.ts src/site/video-retry.ts src/server.ts test/routes/public-video.test.ts
git commit -m "feat(video): add public video routes with Range and 202+retry"
```

---

### Task 7: Widget (video.ts + video-attrs.ts + CSS + theming)

**Files:**
- Create: `src/widgets/video-attrs.ts`
- Create: `src/widgets/video.ts`
- Modify: `src/lib/widgets.ts` (register video widget)
- Modify: `src/templates/post.ts` or `src/lib/content.ts` RenderCtx to add `videos: VideoMap`
- Modify: `static/themes/default.css` (add .rkr-video hooks)
- Modify: `docs/theming.md` (document new hooks)
- Test: `test/widgets/video.test.ts`

**Interfaces:**
- Consumes: `VideoMap` (Task 5), `cacheKey`, `ImageMap` unchanged.
- Produces: `parseVideoAttrs(attrs)` validation, `video widget render(node, ctx:{videos:VideoMap}) -> html` with `<figure class="rkr-video rkr-justify-..."><div class="rkr-video-wrapper" style="--rkr-video-aspect: W/H"><video controls preload="metadata" poster="..." src="..." width height data-duration> ...`

- [ ] **Step 1: Write failing widget test**

```ts
// test/widgets/video.test.ts
it('parses trim poster', () => { expect(parseTrim("2.0-45.5")).toEqual({startMs:2000,endMs:45500}) });
it('rejects invalid ids comma-list', () => { expect(validate({ids:"a,b"}).ok).toBe(false) });
it('renders video with poster and aspect', () => { const html = render({attributes:{ids:id}}, {videos: map}); expect(html).toContain('<video'); expect(html).toContain('poster="/video/poster/'); expect(html).toContain('--rkr-video-aspect') });
it('invalid trim -> comment', () => { expect(render(invalidTrimNode, ctx)).toContain('<!-- invalid video widget') });
it('unknown id -> missing comment', () => { expect(render({ids:'0'.repeat(64)},ctx)).toContain('missing video') });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/widgets/video.test.ts` Expected: FAIL

- [ ] **Step 3: Implement video-attrs.ts + video.ts**

- `video-attrs.ts`: export `parseTrim(s:string)->{startMs,endMs}|null`, `parsePoster(s:string)->number|null`, `parseVideoWidth`, reusing `figure-attrs.ts` for justify/width/caption. Validate `ids` is single 64-hex lowercased, reject comma, `trim` float seconds 0<=start<end<=duration (defer duration check to render), `poster` float, `controls` default true, `autoplay/muted/loop` booleans, when autoplay true force muted+playsinline in render, `caption` string. Export `validateVideoAttrs(attrs): ValidateResult`.

- `video.ts`: `name='video'`, `variants=[{w:1920,formats:['mp4']}]` poster `{w:640,format:'jpg'}`, `fallback={w:640,format:'jpg'}`. `render(node,ctx)` lookup `id` in `VideoMap`, missing -> `<!-- missing video: ${id} -->`; compute `trimOp` from attrs, validate range vs `src.durationMs` -> invalid comment; compute `ophash` via `cacheKey`, `phash` for poster, build `videoUrl`/`posterUrl`, emit html figure with wrapper aspect `width/height` from sidecar source, classes `rkr-video rkr-justify-${justify}`.

- Register in `src/lib/widgets.ts` widget registry (add `video` entry).
- Extend `RenderCtx`/`WidgetCtx` to include `videos: VideoMap` (search for `RenderCtx` definition in `src/lib/content.ts` and `src/lib/widgets.ts`; add field, thread through `renderPostHtml` and `buildImageMap` call sites).
- CSS in `default.css`: append `.rkr-video {margin: var(--rkr-figure-margin) auto}`, `.rkr-video-wrapper{aspect-ratio: var(--rkr-video-aspect,16/9); overflow:hidden; border-radius:var(--rkr-radius); background:var(--rkr-rule)}`, `.rkr-video-wrapper video{width:100%;height:auto;display:block}`, `.rkr-video-caption{font-family:var(--rkr-display-font);font-size:.875rem;color:var(--rkr-muted);text-align:center;margin-top:.5rem}`. Reuse `.rkr-justify-*` no new ones.
- Update `docs/theming.md` stable hooks table with the 4 new selectors.

- [ ] **Step 4: Run widget tests + tsc**

Run: `npm test -- test/widgets/video.test.ts` Expected: PASS
Run: `npx tsc --noEmit` Expected: clean

- [ ] **Step 5: Commit**

```bash
git add src/widgets/video-attrs.ts src/widgets/video.ts src/lib/widgets.ts src/lib/content.ts static/themes/default.css docs/theming.md test/widgets/video.test.ts
git commit -m "feat(video): add ::video widget with attrs and theme hooks"
```

---

### Task 8: Admin upload/trim + TipTap node + OPFS map + markdown round-trip

**Files:**
- Modify: `src/routes/admin.ts` (add POST /admin/upload/video and POST /admin/video/:id/trim)
- Create: `src/admin/video-node.ts`
- Create: `src/admin/video-map-opfs.ts`
- Modify: `src/lib/prose-markdown.ts` (add video directive round-trip)
- Modify: `src/admin/admin.ts` (wire video map)
- Test: `test/routes/admin-video-upload.test.ts`, `test/lib/prose-markdown-video.test.ts`

**Interfaces:**
- Consumes: `ingestVideoStream` (Task 4), `renderVideoDerivative` (Task 5), `readVideoSidecar/writeVideoSidecar` (Task 2)
- Produces: `POST /admin/upload/video -> {id,videoUrl,posterUrl,durationMs,width,height}`, `POST /admin/video/:id/trim {startMs,endMs,posterTimeMs} -> {videoUrl,posterUrl}`, TipTap `video` node with `::video` serialization, OPFS video map.

- [ ] **Step 1: Write failing tests**

```ts
// test/routes/admin-video-upload.test.ts
it('POST /admin/upload/video ingests and returns urls', async () => { /* multipart with mocked probe/ffprobe */ expect(res.json().id).toMatch(/^[0-9a-f]{64}$/) });
it('POST /admin/video/:id/trim validates range', async () => { /* 422 on start>=end */ });
```
```ts
// test/lib/prose-markdown-video.test.ts
it('round-trips ::video directive', () => { const md='::video{ids="ab..."}'; const prosemirror=markdownToProse(md); expect(proseToMarkdown(prosemirror)).toContain('::video') });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/routes/admin-video-upload.test.ts test/lib/prose-markdown-video.test.ts` Expected: FAIL

- [ ] **Step 3: Implement**

- `admin.ts`: add `fastify.post('/admin/upload/video', {preHandler:requireUser, config:{rateLimit...}}, async(req,reply)=>{ const part=await req.file(); ingestVideoStream({stream:part.file, siteRoot, source:{kind:'upload',originalName:part.filename}}); await renderVideoDerivative({originalId:id, ops:[], posterTimeMs, siteRoot}); return {id,videoUrl,posterUrl,durationMs,width,height}; handle probe 422, cap 413, 500 })`. Add `POST /admin/video/:id/trim` validating startMs/endMs/posterTimeMs against duration, updating sidecar `ops = trim?[{kind:"trim",startMs,endMs}]:[]` , `poster.timeMs`, clearing `redoStack`, `writeVideoSidecar`, invalidating cache (old files remain), responding new urls (computed via cacheKey). Share auth/rate limit with existing upload.

- `video-node.ts`: `Node.create({name:'video', group:'block', atom:true, draggable:true, selectable:true, addAttributes(){return {ids:{default:null}, trim:{default:null}, poster:{default:null}, caption:{default:null}, width:{default:null}, justify:{default:null}, controls:{default:true}, autoplay:{default:false}}}})`, `parseHTML: [{tag:'div[data-video]'}]`, `renderHTML: ({HTMLAttributes})=>['div',{'data-video':..., 'data-ids':...}, ['video',{src:HTMLAttributes.videoUrl, poster:HTMLAttributes.posterUrl, controls:''}]]`, `addNodeView()=>{ preview video element + popover with <input type=number step=0.1> for trim start/end/poster + caption }`.

- `video-map-opfs.ts`: mirror `image-map-opfs.ts` but read `sidecars/videos` from OPFS: `export async function buildVideoMapFromOpfs(opfsRoot, fetchFn?): Promise<VideoMap>` scanning, computing urls via same cacheKey.

- `prose-markdown.ts`: add `video` to `parseMarkdown` directive visitor (handle `::video` -> node type video with attrs) and `proseToMarkdown` serializer (video node -> `::video{ids="..." trim="a-b" poster="..." caption="..."}`).

- Wire `src/admin/admin.ts`: import `buildVideoMapFromOpfs`, provide video map to editor state.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/routes/admin-video-upload.test.ts test/lib/prose-markdown-video.test.ts` Expected: PASS
Run: `npm run lint && npx tsc --noEmit` Expected: clean

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin.ts src/admin/video-node.ts src/admin/video-map-opfs.ts src/lib/prose-markdown.ts test/routes/admin-video-upload.test.ts test/lib/prose-markdown-video.test.ts
git commit -m "feat(video): add admin upload/trim, TipTap node, OPFS map, markdown round-trip"
```

---

### Task 9: E2E + Dockerfile + deps

**Files:**
- Modify: `Dockerfile` / `fly-deploy/Dockerfile` (install ffmpeg)
- Modify: `package.json` if needed (no new deps, ffmpeg is system dep)
- Create: `test/e2e/video-upload.spec.ts`, `test/e2e/public-videos.spec.ts`
- Test: `npm run test:e2e` relevant

**Interfaces:**
- Consumes: all prior tasks.
- Produces: passing e2e with coverage-fixtures, ffmpeg available in CI image.

- [ ] **Step 1: Write failing e2e (use coverage-fixtures)**

```ts
// test/e2e/video-upload.spec.ts
test('upload video via admin, trim persists, public video loads', async ({page}) => {
  await login(page); await page.goto('/admin/editor');
  // upload fixture mp4 via /admin/upload/video
  // insert ::video{id="..."} and save
  // verify public post has <video poster>
});
```

- [ ] **Step 2: Run e2e to verify it fails (404 before route)**

Run: `npx playwright test test/e2e/video-upload.spec.ts` Expected: FAIL

- [ ] **Step 3: Implement Dockerfile change**

Add `RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*` to `Dockerfile` (and `fly-deploy/Dockerfile` if separate). Update `npm run setup` docs if needed to mention ffmpeg prerequisite. Ensure `bin/site-admin` gets `video probe <path>` helper (optional, log probe JSON).

- [ ] **Step 4: Run e2e + coverage ratchet**

Run: `npx playwright test test/e2e/video-upload.spec.ts test/e2e/public-videos.spec.ts` Expected: PASS
Run: `npm test -- --coverage` check c8 thresholds not breached.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile test/e2e/video-upload.spec.ts test/e2e/public-videos.spec.ts
git commit -m "feat(video): e2e and ffmpeg deploy dep"
```

---

## Self-Review

- Spec §1-4 storage/sidecar/ingest/transcode covered in Tasks 1-5.
- Spec §4 serving + Apache in Task 6 + Task 1.
- Spec §5 widget in Task 7.
- Spec §6 VideoMap in Task 5.
- Spec §7 admin in Task 8.
- Spec §8 themes/CSS in Task 7.
- Spec §9 video-retry client in Task 6.
- Spec §11 error codes (422/413/404/416/202) in Tasks 4+6.
- Spec §12 testing unit/integration/e2e in Tasks 2-9.
- Spec §13 deployment ffmpeg in Task 9.

No TBD/TODO. Types: `VideoOp {kind:"trim",startMs,endMs}`, `cacheKey({originalId,ops:{kind},variant:{w},output:{format}})` consistent across map/render/widget/route verification.
