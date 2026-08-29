# Self-hosted video v1 (isolated path) — design

**Source.** User request 2026-08-28: add video to the blog where any photo can be displayed; self-hosted; single transcode per video; video editing limited to trimming (non-destructive); v1 is a standalone `::video` element (not mixed inside `::figure`), with a later phase to integrate with images.

## Goal

A single-file video widget `::video{id="..." ...}` that mirrors the image pipeline shape but stays isolated from `figure.ts`/`ImageMap`/`lightbox`. Uploaded videos are hash-addressed, stored under `originals/videos`, described by a JSON sidecar with a non-destructive `trim` op, transcoded once to normalized `mp4` (h264/aac) via `ffmpeg`, cached under `cache/video`, and served with range requests via `GET /video/...` (Apache cache-hit fast path like `/img`). Trimming rewrites the sidecar, not the original.

This v1 intentionally defers mixed galleries (video cells inside `::figure`). The storage/sidecar/hash/caching contracts are shaped so that later unification (`ImageMap`+`VideoMap` → `MediaMap`) is a rename/re-wire, not a migration.

## Decisions (locked)

- **Self-hosted, single transcode.** One normalized `mp4` per logical video (no HLS/DASH, no adaptive renditions). Poster is a single `jpeg` extracted via `ffmpeg`.
- **Non-destructive trim.** `ops: [{kind:"trim", startMs, endMs}]` in the video sidecar, preserved original, `redoStack` like image ops. Re-trimming re-hashes the cache key and re-transcodes.
- **Isolated v1.** New widget `::video`, new `VideoMap`, new ingest/serve path. `figure.ts` (already at 500-line cap), `image-map-fs.ts`/`image-map-opfs.ts`, and `lightbox.ts` are untouched for v1.
- **Normalization target.** `mp4` container, `h264` video + `aac` audio, yuv420p, `+faststart`, capped at 1920w (height auto, even). Preset `fast`, CRF `23`. Choice favors universal browser playback over size.
- **Synchronous transcode with 202+retry fallback.** Like `public-img.ts`, render within `renderBudgetMs` (default 8s); on timeout/queue, return 202 and client polls with backoff (`src/site/video-retry.ts` mirroring `img-retry.ts`).

## Existing patterns this follows

- Hash-addressed originals: `originals/<aa>/<bb>/<id>.<ext>` via sha256-of-bytes, dedup, atomic tmp+rename (`src/lib/originals.ts`).
- Sidecars: `sidecars/<id>.json` with `version`, `source`, `ops`, `redoStack`, `outputs`, `variants` (see `packages/image-edit/src/core/sidecar-types.ts` and `src/lib/sidecar.ts`). Video adds `sidecars/videos/<id>.json`.
- Cache key: hash of `(originalId, ops, output)` → `cache/img/<id>.<ophash>.<fmt>` (`src/lib/hash.ts:cacheKey`). Video reuses shape: `cache/video/<id>.<ophash>.mp4` and `cache/video/<id>.<ophash>.jpg` for poster.
- Derivative render: `src/lib/render.ts:renderDerivative` (sharp, `concurrency(1)`, 202, dedup semaphore). Video adds `src/lib/video-render.ts:renderVideoDerivative`.
- Widget registry: `src/lib/widgets.ts` + `src/widgets/figure.ts`/`figure-attrs.ts`, validation + render, `WidgetCtx`.
- Upload: `POST /admin/upload` (`@fastify/multipart`) in `src/routes/admin.ts`; URL import `POST /admin/import/url`; gdrive/onedrive imports.
- Serving: Apache DocumentRoot = SITE_ROOT, `fly-deploy/apache.conf` rewrite for `/cache/img` fast path, Fastify `public-img.ts` on miss with `immutable` cache header and 600/min/IP rate limit.
- Editor: TipTap `figure` node `src/admin/figure-node.ts` + `src/lib/prose-markdown.ts` round-trip + `src/admin/image-map-opfs.ts` preview map.
- Themes: `static/themes/default.css` owns all layout; other themes override color/spacing only; new public classes added to `docs/theming.md` stable hooks same-commit.
- Tests: `node:test` unit (`test/**/*.test.ts`), Playwright e2e with `test/e2e/coverage-fixtures.ts`, c8 per-file thresholds, `src/admin/**` excluded from unit coverage.

## 1. Storage & sidecar

### 1.1 Paths — `src/lib/config.ts:paths()`

Add `originalsVideo: <root>/originals/videos`, `sidecarsVideo: <root>/sidecars/videos`, `cacheVideo: <root>/cache/video`. Apache `DocumentRoot` already covers new cache subtree; new rewrite in `fly-deploy/apache.conf` maps `/video/<file>` cache hits to `/cache/video/<file>` verbatim (same as `/img`).

### 1.2 Video sidecar — `packages/image-edit/src/core/sidecar-types.ts` + `src/lib/video-sidecar.ts`

```ts
interface VideoSidecar {
  version: 1;
  original: string; // original relative path, e.g. "videos/ab/cd/<id>.mp4"
  source: {
    kind: "upload" | "url" | "gdrive" | "onedrive";
    fetchedAt: string; // ISO
    originalName: string;
    storedHash: string; // sha256 hex
    uploadFormat: string; // e.g. "mp4" | "mov" | "webm"
    uploadBytes: number;
    uploadWidth: number;
    uploadHeight: number;
    durationMs: number;
    probe: { codecVideo: string; codecAudio: string | null };
  };
  ops: VideoOp[];           // currently only TrimOp
  redoStack?: VideoOp[];
  outputs: [{ format: "mp4"; codec: "h264/aac"; quality?: number }];
  poster: { timeMs: number }; // poster extraction time
}
type VideoOp = { kind: "trim"; startMs: number; endMs: number };
```

`outputs` is fixed for v1 (single mp4). `poster.timeMs` defaults to `min(1000, durationMs/2)` at ingest, editable via widget attr. Read/write/validate mirrors `src/lib/sidecar.ts` (atomic write, schema validation, version guard).

### 1.3 Video id & hash

Video id = lowercased sha256 hex of original bytes (same as images). Cache ophash = `cacheKey({originalId: id, ops, variant: {w: 1920}, output: {format:"mp4"}})` reusing `src/lib/hash.ts`. Poster ophash = `cacheKey({originalId: id, ops, variant: {w: 640}, output: {format:"jpg"}})` (single poster width).

## 2. Ingest — `src/lib/video.ts:ingestVideoStream`

```ts
interface IngestVideoArgs {
  stream: Readable;
  siteRoot: string;
  source: { kind: VideoSidecar["source"]["kind"]; originalName: string; fetchedAt?: string };
  caps?: { maxBytes?: number; maxDurationMs?: number; maxWidth?: number }; // defaults 500MiB, 300_000ms, 1920
}
interface IngestVideoResult { id: string; path: string; ext: string; bytes: number; deduplicated: boolean; sidecar: VideoSidecar; durationMs: number; width: number; height: number }
function ingestVideoStream(args: IngestVideoArgs): Promise<IngestVideoResult>
```

Steps: stream to temp file → sha256 → `ffprobe` for width/height/duration/codecs → cap checks → dedup (if original path exists, reuse) → move to `originalsVideo/<aa>/<bb>/<id>.<ext>` → write `sidecarsVideo/<id>.json` → return. EXIF orientation not relevant; ingest re-encode is not applied (transcode stage handles normalization). `passthrough` not needed for v1.

## 3. Transcode & poster — `src/lib/video-render.ts` + `src/lib/video-ffmpeg.ts`

```ts
interface VideoDerivativeArgs { originalId: string; ops: VideoOp[]; posterTimeMs: number; siteRoot: string; force?: boolean }
interface VideoRenderResult { videoPath: string; posterPath: string; bytes: number; cached: boolean }
function renderVideoDerivative(args: VideoDerivativeArgs): Promise<VideoRenderResult>
```

- Cache lookup: both `cacheVideo/<id>.<ophash>.mp4` and `cacheVideo/<id>.<ophash>.jpg` exist → return cached.
- Video transcode: `ffmpeg -ss <startMs/1000> -to <endMs/1000> -i <original> -vf scale='min(1920,iw)':-2:flags=lanczos -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart <tmp>.mp4` (if no trim, omit `-ss`/`-to`; if source already h264/aac and within caps and no trim, still re-encode for `faststart` determinism).
- Poster: `ffmpeg -ss <posterTimeMs/1000> -i <cacheVideoMp4> -vframes 1 -q:v 2 <tmp>.jpg` (uses transcoded file so poster reflects trim; clamped to `[startMs, endMs)` and to duration).
- Atomic rename into `cacheVideo`. Concurrency: dedup map + semaphore like `render.ts` (single `ffmpeg` at a time or `concurrency(2)` on larger hosts; v1 uses single to bound memory). Timeout via `renderBudgetMs`.

`src/lib/video-ffmpeg.ts` is the thin `spawn ffmpeg/ffprobe` wrapper (arg escaping, timeout, stderr capture, ENOENT → actionable error).

## 4. Serving — `src/routes/public-video.ts`

Registered as `registerPublicVideoRoutes(fastify, {siteRoot, db, renderBudgetMs})`.

- `GET /video/:filename` where `:filename` = `<64-hex-id>.<12-hex-ophash>.mp4` (same regex as `/img`).
- `GET /video/poster/:filename` where `:filename` = `<64-hex-id>.<12-hex-ophash>.jpg`.
- On cache hit: set `Content-Type` (`video/mp4` / `image/jpeg`), `Cache-Control: public, max-age=31536000, immutable`, `Accept-Ranges: bytes`, support `Range` (206 with `Content-Range`, 416 on invalid), stream file. Apache serves hits directly when rewrite matches; Fastify handles misses and range logic.
- On cache miss: validate hex/ophash, load `VideoSidecar`, verify ophash matches current `ops+posterTimeMs` (if not, 404 — stale URL), then `renderVideoDerivative` within budget; on success stream, on timeout queue background render and return `202 Accepted` with `Retry-After: 2` (client retries).
- Rate limit 600/min/IP, render dedup keyed by `(id, ophash)`.
- Apache `fly-deploy/apache.conf`: add `RewriteRule ^/video/([0-9a-f]+\.[0-9a-f]+\.mp4)$ /cache/video/$1 [L]` and poster rule, with `Header set Cache-Control "public, max-age=31536000, immutable"` for `/cache/video`.

## 5. Widget — `src/widgets/video.ts` + `src/widgets/video-attrs.ts`

Directive: `::video{ids="ab12..." trim="2.0-45.5" poster="2.0" controls autoplay muted loop width="center|full|bleed" caption="..."}`

- `ids` is a single 64-hex id (reuse `FigureAttrs` validation shape but single-value for v1; reject comma-list with clear error).
- `trim="start-end"` seconds (float, e.g. `"2-45.5"` or `"0-10"`); parsed to `startMs`/`endMs`, validated `0 <= start < end <= durationMs`. Absent → no trim.
- `poster="1.5"` seconds; validated within `[startMs, endMs)` or `[0, durationMs)`.
- `width` / `justify` reuse figure geometry vocabulary but map to `.rkr-video` classes.
- `caption` optional string.
- `controls` defaults true; `autoplay`/`muted`/`loop` booleans (when `autoplay` set, template forces `muted` and `playsinline` per browser policy).
- `render(node, ctx: VideoWidgetCtx)` where `VideoWidgetCtx { videos: VideoMap }`. Looks up `id` in `VideoMap` (built like `ImageMap` but from `sidecars/videos`), computes `ophash` from current sidecar ops+poster, emits:

```html
<figure class="rkr-video rkr-justify-...">
  <div class="rkr-video-wrapper" style="--rkr-video-aspect: 16/9">
    <video controls preload="metadata" poster="/video/poster/<id>.<phash>.jpg"
           src="/video/<id>.<vhash>.mp4" width="..." height="..." data-duration="...">
      Sorry, your browser doesn't support embedded videos.
    </video>
  </div>
  <figcaption class="rkr-video-caption">...</figcaption>
</figure>
```

CLS reservation via `--rkr-video-aspect` (width/height from probed dims after trim). `loading` not applicable; `preload="metadata"` is the equivalent.

Unknown `::video` id → `<!-- missing video: <id> -->` (like `figure.ts` missing-image handling).

## 6. VideoMap — `src/lib/video-map-fs.ts` + `src/admin/video-map-opfs.ts`

Mirrors `src/lib/image-map-fs.ts` / `src/admin/image-map-opfs.ts`:

- `interface VideoSource { sidecar: VideoSidecar; width: number; height: number; durationMs: number; urlFor(ops, posterTimeMs): {videoUrl: string; posterUrl: string} }`
- `type VideoMap = Map<string, VideoSource>` keyed by lowercased id as written.
- `buildVideoMap(siteRoot): Promise<VideoMap>` scans `sidecars/videos/*.json`, probes dims if needed, self-heals missing bakes (poster/video cache is derivative, not bake).
- Admin offline preview: `buildVideoMapFromOpfs(opfsRoot): Promise<VideoMap>`.

`RenderCtx` gains `videos: VideoMap` alongside `images`. `content.ts:renderPostHtml` threads it through. Widget registry dispatches `video` with `VideoWidgetCtx`.

## 7. Admin

- `POST /admin/upload/video` (`@fastify/multipart`, same auth/rate-limit as `/admin/upload`) → `ingestVideoStream` → `renderVideoDerivative` (eager, within budget) → `{id, videoUrl, posterUrl, durationMs, width, height}` JSON.
- `POST /admin/video/:id/trim` with `{startMs, endMs, posterTimeMs}` → validate, update sidecar `ops`/`poster`/`redoStack`, invalidate cache (old ophash files remain immutable, new ophash generated on next render), respond with new URLs. (Alternatively, trim is edited as widget attrs and saved via post markdown sync; dedicated endpoint is for live preview without saving the post. Keep both: widget attrs are source of truth, preview endpoint is optimistic.)
- TipTap node `src/admin/video-node.ts`: `Node.create({name:"video", group:"block", atom:true, draggable:true, attrs:{ids, trim, poster, caption, width, ...}})`, renders as a preview `<video>` with poster, edit popover with two number inputs `Trim start (s)` / `Trim end (s)` / `Poster at (s)` + caption. Serialized via `src/lib/prose-markdown.ts` to `::video{...}`.
- Client `src/admin/video-map-opfs.ts` and `src/admin/admin.ts` wiring mirrors image flow.

## 8. Themes & CSS — `static/themes/default.css` + `docs/theming.md`

New stable hooks (all in `default.css`, documented in `theming.md`):

- `.rkr-video` (figure container, margin via `--rkr-figure-margin` reuse)
- `.rkr-video-wrapper` (aspect reservation via `--rkr-video-aspect`, `overflow:hidden`, `border-radius`)
- `.rkr-video-wrapper video` (`width:100%; height:auto; display:block`)
- `.rkr-video-caption` (typography, muted color)
- `.rkr-justify-*` reuse from figure (center/left/right/full/bleed) — no new justify classes.

Other themes override only color/spacing; v1 adds no layout geometry they must redefine.

## 9. Client JS — `src/site/video-retry.ts`

Cloned from `src/site/img-retry.ts`: retries `GET /video/...` 202s with capped exponential backoff, abort on tab hidden, swap `src` on success. Included in `src/templates/post.ts` bundle.

## 10. Data flow

Upload (`POST /admin/upload/video`) → `ingestVideoStream` → `originals/videos` + `sidecars/videos` → eager `renderVideoDerivative` → `cache/video` (+ poster) → `buildVideoMap` → `renderPostHtml` with `VideoMap` → `::video` → `<video poster>` → Apache serves `cache/video` hits, Fastify renders misses with 202+retry.

Post save: markdown `::video{...}` persisted to `content/posts/*.md`; `runReindex` unchanged for v1 (video not indexed for FTS). Deleting a post does not GC videos (explicit `bin/site-admin video gc` later).

## 11. Error handling / edge cases

- Probe failure or unsupported container → `422 Unprocessable Entity` with `Unsupported video format` (ffprobe exit).
- Over caps (`uploadBytes > 500MiB`, `durationMs > 300000`, `width > 7680`) → `413` with cap message (caps from `config/site.json#videoCaps` or defaults).
- `trim` `startMs >= endMs` or out of `[0, durationMs]` → widget `validate` returns `{ok:false, error:"trim out of range"}` → render `<!-- invalid video widget: ... -->` and admin popover shows inline error.
- `posterTimeMs` outside `[startMs or 0, endMs or durationMs)` → clamp or validation error (clamp for render, validation error for editor).
- `ffmpeg` crash/timeout → log stderr, return `500`, client retry shows transient error; 202 path retries server-side.
- Missing sidecar or orphan original → `<!-- missing video: ... -->`; `bin/site-admin video gc` reports orphans (future).
- Range out-of-bounds → `416 Range Not Satisfiable`.
- Stale ophash in URL (sidecar ops changed since URL emitted) → `404` (post re-render emits new URL).

## 12. Testing

- **Unit** `test/lib/video-sidecar.test.ts`: read/write/validate, version guard, atomic write.
- **Unit** `test/lib/video.test.ts`: ingest dedup, cap rejection, probe parsing (mocked ffprobe), sidecar shape.
- **Unit** `test/lib/video-render.test.ts`: hash stability (same ops → same ophash), trim changes hash, ffmpeg args (mocked spawn), poster path.
- **Unit** `test/widgets/video.test.ts`: attrs validation (ids/trim/poster/width/caption), render cases (no trim, with trim, invalid → comment), CLS aspect style present, range headers not tested here.
- **Integration** `test/routes/public-video.test.ts`: cache hit 200 + range 206, cache miss 202 then 200 after render, 404 stale ophash, 422 invalid trim, 413 over cap.
- **E2E** `test/e2e/video-upload.spec.ts` and `public-videos.spec.ts`: upload via admin, trim edits persist, public page loads `<video>` with poster, 202 retry path (use `coverage-fixtures.ts`).
- `node:test` throughout; `c8` coverage; new browser code in `src/site/video-retry.ts` and `src/admin/video-node.ts` covered by e2e V8 ratchet.

## 13. Deployment & ops

- `ffmpeg` + `ffprobe` required on host (Debian `ffmpeg` package). `Dockerfile`/`fly-deploy` installs it. `bin/site-admin` gains `video probe <path>` and `video gc` helpers. `npm run setup` documents ffmpeg dep (like chromium binary).
- `gen-precache.ts` not changed (video cache is not precached). `deploy/` and `fly-deploy/apache.conf` updated as above.

## 14. Out of scope (YAGNI)

- Mixed `::figure` galleries (video cells inside figure grid/carousel/justified/masonry) — deferred to phase 2 (unifies `VideoMap`/`ImageMap` → `MediaMap`, teaches `figure.ts` to emit `<video>` per cell, extends `lightbox.ts` for video).
- Adaptive HLS/DASH, multiple renditions, ABR player.
- Waveform/timeline trim UI, thumbnail strip, chapter markers.
- FTS indexing of video captions, comments on video timestamps.
- Background job queue beyond the 202+retry pattern (no BullMQ).
- GC of orphan videos on post delete.

## 15. Implementation order

1. `config.ts` paths + site caps + Apache rewrite.
2. `video-sidecar.ts` + `video-ffmpeg.ts` (probe wrapper).
3. `video.ts` ingest + `video-render.ts` transcode/poster + `video-map-fs.ts`.
4. `public-video.ts` route + `video-retry.ts` client.
5. `widgets/video.ts` + `video-attrs.ts` + `theming.md` + `default.css`.
6. `admin` upload route + `video-node.ts` + `video-map-opfs.ts` + `prose-markdown.ts` round-trip.
7. Tests + `Dockerfile` ffmpeg install.

## 16. Risks

- `ffmpeg` binary size and CPU on first transcode (mitigate with single-concurrency and `renderBudgetMs`).
- Duration probe for variable-frame-rate inputs (rely on `ffprobe` duration, not frame count).
- Poster time outside trim window — clamp prevents black poster.
