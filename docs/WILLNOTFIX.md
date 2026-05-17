# Won't fix (accepted)

Decisions, not a backlog. These were once tracked as "deferred" but
on review they are deliberate choices for a single-author blog, not
postponed work — keeping them in the queue implies an intent to do
them that doesn't exist. Listed here so the reasoning stays findable
and we don't re-litigate. Reopen only if the stated assumption breaks.

- **Sliding-session lookup timing (M3)** — a theoretical timing
  side-channel on session-id lookup. Accepted risk at single-author
  scale; a constant-time fix costs more code/complexity than the
  threat warrants. Reopen only if session ids get exposed via
  headers/logs or the service serves many concurrent unauth clients.
- **Persisted retry budget across reload** — the outbox `attempts`
  counter resetting on reload *is* the intended model ("refresh to
  retry"). Persisting it would need an `OutboxEntry` schema migration
  to make the product behave worse. Not a fix.
- **Multi-level comment threading** — one level of replies is a
  deliberate product decision (keeps rendering, moderation order, and
  WP-import flattening simple). Not postponed; chosen.
- **CAPTCHA / third-party bot protection** — declined on purpose: a
  CAPTCHA requires third-party scripts that break the strict CSP and
  add reader friction. Honeypot + min-fill-time + rate-limit are
  sufficient for a low-traffic personal blog. Reopen only if spam
  actually bypasses the existing guards.
- **`src/admin/pick.ts` e2e coverage** (7 LOC) — the OS file picker
  is structurally untestable from headless Playwright (`setInputFiles`
  bypasses the click path). Permanently skipped, not pending.
- **`public-figures.spec.ts:134` carousel-autoplay flake** — an
  environmental headless tab-visibility quirk, not a code bug. Tracked
  as a known low-rate flake; "fixing" it means chasing the browser,
  not the app. Reopen only if the rate climbs materially.
