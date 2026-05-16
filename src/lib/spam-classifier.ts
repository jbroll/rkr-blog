// Spam classifier. Calls the token-auth'd Ollama proxy on symon
// (/ollama/api/generate) with a pinned prompt and format=json. No DB,
// no env reads (caller passes config so it's testable and the job
// handler controls retry/fallback policy). Bounded retries live here
// because the jobs table has no auto-retry; on exhaustion we throw and
// the handler fails the comment safe (→ 'queued').
//
// The default transport is node:https, NOT global fetch. The proxy is
// reached on port 554 (the only Fios-forwarded entry to the GPU box;
// :443 is the router admin). The WHATWG Fetch standard's static
// "bad ports" blocklist includes 554 (RTSP, by convention only), and
// undici/Node `fetch` enforces it with no opt-out — so `fetch` rejects
// the request pre-flight with an opaque `cause: bad port` and the
// comment silently queues forever. node:https does not implement that
// browser-oriented blocklist, so it reaches :554 fine. Do NOT switch
// the default back to `fetch`. Tests inject their own fetcher.

import https from 'node:https';

export interface SpamInput {
  authorName: string;
  authorEmail: string;
  body: string;
}

export interface SpamVerdict {
  verdict: 'ham' | 'spam';
  score: number; // 0..1
  reason: string;
}

export type SpamFetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface ClassifyConfig {
  baseUrl: string; // e.g. https://symon.rkroll.com/ollama (no trailing slash needed)
  token: string;
  model: string;
  timeoutMs: number;
  maxAttempts: number;
  fetcher?: SpamFetcher;
}

const SYSTEM_PROMPT = [
  'You are a spam classifier for blog comments on a personal photography blog.',
  'Classify the comment as "spam" or "ham" (not spam).',
  'Treat as spam: unsolicited promotion, SEO link-dropping, link-heavy or',
  'gibberish text, off-topic advertising, or content unrelated to a photo blog.',
  'Treat as ham: short appreciative notes, questions, on-topic discussion —',
  'brevity is normal and is NOT spam.',
  'Respond with ONLY a JSON object, no prose, exactly:',
  '{"verdict":"ham|spam","score":<0..1 spam probability>,"reason":"<short>"}'
].join(' ');

function buildPrompt(c: SpamInput): string {
  return [
    SYSTEM_PROMPT,
    '',
    `Author name: ${c.authorName}`,
    `Author email: ${c.authorEmail}`,
    'Comment body:',
    c.body
  ].join('\n');
}

function parseVerdict(modelText: string): SpamVerdict {
  // The model may wrap JSON in stray text; grab the first {...} block.
  // Greedy match is safe because format:'json' pins one object; removing format:'json' or enabling streaming would break this.
  const m = modelText.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON object in model output');
  const parsed = JSON.parse(m[0]) as Record<string, unknown>;
  const verdict = parsed.verdict === 'spam' ? 'spam' : parsed.verdict === 'ham' ? 'ham' : null;
  if (verdict === null) throw new Error('missing verdict field');
  const scoreRaw = typeof parsed.score === 'number' ? parsed.score : verdict === 'spam' ? 1 : 0;
  const score = Math.max(0, Math.min(1, scoreRaw));
  const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 280) : '';
  return { verdict, score, reason };
}

/* c8 ignore start -- default transport: real network I/O, exercised in
   production / e2e; unit tests inject cfg.fetcher instead. */
const httpsFetcher: SpamFetcher = (url, init = {}) =>
  new Promise((resolve, reject) => {
    const req = https.request(
      new URL(url),
      {
        method: init.method ?? 'GET',
        headers: init.headers as Record<string, string> | undefined
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0 }))
        );
      }
    );
    req.on('error', reject);
    const signal = init.signal as AbortSignal | null | undefined;
    if (signal) {
      if (signal.aborted) req.destroy(new Error('aborted'));
      else
        signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    }
    if (init.body != null) req.write(init.body as string);
    req.end();
  });
/* c8 ignore stop */

async function callOnce(input: SpamInput, cfg: ClassifyConfig): Promise<SpamVerdict> {
  /* c8 ignore next */
  const fetcher = cfg.fetcher ?? httpsFetcher;
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/api/generate`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
  try {
    const res = await fetcher(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: cfg.model,
        prompt: buildPrompt(input),
        stream: false,
        format: 'json',
        options: { temperature: 0 }
      }),
      signal: ac.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { response?: unknown };
    if (typeof data.response !== 'string') throw new Error('no response field');
    return parseVerdict(data.response);
  } finally {
    clearTimeout(timer);
  }
}

export async function classifyComment(input: SpamInput, cfg: ClassifyConfig): Promise<SpamVerdict> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    try {
      return await callOnce(input, cfg);
    } catch (err) {
      lastErr = err;
    }
  }
  // undici's `fetch failed` is opaque — the real reason (DNS, ECONNREFUSED,
  // TLS, timeout) lives in error.cause. Surface it so transient failures
  // are diagnosable from the stored spam_reason instead of just "fetch failed".
  const e = lastErr as (Error & { cause?: unknown }) | undefined;
  const causeMsg =
    e && typeof e === 'object' && 'cause' in e && e.cause != null
      ? ` (${(e.cause as Error)?.message ?? String(e.cause)})`
      : '';
  throw new Error(
    `spam classify failed after ${cfg.maxAttempts} attempts: ${
      e?.message ?? String(lastErr)
    }${causeMsg}`
  );
}
