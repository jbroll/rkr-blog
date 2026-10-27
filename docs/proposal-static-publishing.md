# Proposal: static publishing, auth at the proxy, separate services

Status: for later consideration. Nothing here is decided or built. Written 2026-10-21 from a design conversation about moving the Electric City Community Grocery website (`electriccityfood.coop`, now on Squarespace) to self-hosted software. Line counts and file references are from `main` on that date.

## Why

The co-op needs non-technical staff to publish monthly "Food for Thought" pages and other news, with a small public attack surface. The site would run next to Nextcloud on `cloud.eccg`, which holds all co-op documents, so a break-in through the website must not reach anything else. WordPress was rejected for that reason: most WordPress break-ins come through plugins, and it would share a server with the documents.

rkr-blog's editor fits the non-technical author well: no Markdown is shown, and images import from desktop, Drive, OneDrive, or a URL. The proposal makes readers see only static files and moves every credential-handling piece out of the editor.

## Architecture

```
readers ──▶ Caddy/Apache file_server ──▶ current build directory (HTML, images, video, Pagefind index)

editors ──▶ proxy ──forward_auth──▶ auth service (one per deployment)
              │  Remote-User / Remote-Email header
              ▼
            editor service (Unix socket or localhost only)
              │  publish: render whole site → new build dir → swap symlink
              ▼
            build directory

commenters ──▶ comment service (optional, the only public write endpoint)
```

All services live as separate projects in the rkr-blog repo, in the layout `apps/image-pwa` and `packages/image-edit` already use: each with its own README, docs, build, and tests, and deployable on its own.

## Parts

### Static generation is the only reader path

- Publish renders the whole site into a new directory: index pages, tag pages, posts, standalone pages, feed, the legacy WordPress permalink redirect map, and a Pagefind search index. A symlink swap makes it live. Full rebuilds instead of tracking dependencies; image derivatives are cached, so only HTML is redone. Build time at a few hundred posts is not measured.
- The build waits until every derivative its pages reference exists, and fails with the missing names instead of publishing a broken `<img>`.
- Image and video derivatives render at save time. `POST /admin/posts` already enqueues them through `src/routes/admin-prewarm.ts`; the on-request path is only a fallback today.

Removed by this:

| File | Lines | What it does now |
| --- | --- | --- |
| `src/routes/public-img.ts` | 212 | image cache-miss handler, render budget, 202 placeholder |
| `src/routes/public-video.ts` | 249 | the same for video, plus Range/206 (a static server does this) |
| `src/site/img-retry.ts` | 115 | reader-side retry after a 202 |
| `src/site/video-retry.ts` | 142 | the same for video |

Plus the `renderBudgetMs` option in `src/server.ts`, the Apache rewrite rules that send cache misses to Node, the public routes in `src/routes/public.ts` and `/search`, and their tests. `src/lib/semaphore.ts` stays: `src/lib/video-render.ts` uses it. `render.ts`, `video-render.ts`, `jobs.ts`, and the prewarm step stay.

### Auth at the proxy, not in the editor

- The editor reads the user from a trusted header and looks up the role in its allowlist. Only the proxy can reach it, and the proxy strips any client-sent `Remote-*` header. CSRF checks stay, because the proxy's session is still a cookie.
- Deleted from the editor: Google OAuth routes, sessions, the login page, `src/routes/auth.ts`, `src/lib/login-throttle.ts`.
- The login service is a deployment choice:
  - rkr's site: `oauth2-proxy` with its Google provider. Configuration, not new code.
  - The co-op: a small checker (about 50 lines) that forwards the request's cookies to Nextcloud's `/ocs/v2.php/cloud/user?format=json` and returns the user id in a header for Caddy's `copy_headers`. Caddy cannot copy a value out of a response body, which is why this is needed. The co-op's IT docs already use `forward_auth` against that endpoint for a yes/no check.
- No auth plugin interface inside rkr-blog: the two existing pieces above cover both deployments.

### Optional comment service

The one public endpoint that accepts writes, separate from the editor. Keeps today's honeypot, validation, rate limit, minimum fill time, LLM spam triage, moderation queue, and notification email. Moderation (`/admin/comments` today) moves into it, behind the same proxy.

### Per-user history

Commit each save to git with the signed-in person as author, so `git log` shows who changed what and any edit can be reverted. This belongs in the editor, not a separate service.

## What changes for existing features

1. **No-JS search goes away.** Pagefind needs JavaScript. Drafts in search results for a signed-in admin move to the editor's post list.
2. **Sort toggle.** Build both orders, or sort in the browser.
3. **Legacy permalinks.** The `/:y/:m/:d/:slug` 301 becomes a generated redirect map the web server reads.
4. **Login/Logout in the public header.** A static page cannot know who is signed in. Becomes a plain editor link or goes away.
5. **`ADMIN_TOKEN` scripted access.** `import-wp push --to` and `reset --to` send a bearer token to `/admin`; a proxy in front blocks it. Either the proxy accepts a service token, or those commands run on the server against the socket.
6. **Offline sync after the session expires.** The editor now sees a 302 to a login page instead of a 401. `src/admin/sync.ts` must detect it and prompt a re-login.
7. **Comment display.** Published comments, the count bubble, and the "received" notice are rendered by Node today. Either approving a comment triggers a rebuild, or the page fetches comments with a script. The no-JS form can post to the service and redirect to a static thank-you page.
8. **Image rendering.** Every size renders at save time instead of on first request: more disk, slower first publish.
9. **Session expiry.** The 30-day fixed expiry becomes the proxy's setting.

## Open questions

- Do the Google Drive and OneDrive importers also become a separate service? Today their per-user OAuth tokens, `connect`/`callback` routes, and picker-token routes live in the editor. Moving them is what it takes for the editor to hold no credentials at all.
- Comment display: rebuild on approval, or fetch with a script?
- Build time for a full rebuild at the co-op's size (260 pages, 116 of them events).

## Needed for the co-op site, beyond the above

- Standalone pages (13, plus 9 collection index pages) and an editable menu. Today only `_about` exists and the nav is fixed.
- Events with a start date, and upcoming and past listings (116 events today).
- Both are designed in [proposal-page-design.md](./proposal-page-design.md).
- Import from a crawl of the public Squarespace site. `import-wp` reads a live WordPress site or a mysqldump, not Squarespace's WXR export, and that export covers only one blog collection.
- Payments stay out of rkr-blog: Stripe Payment Links appear as ordinary links in pages.
