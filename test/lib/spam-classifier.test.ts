import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyComment, type SpamFetcher } from '../../src/lib/spam-classifier.ts';

const cfg = {
  baseUrl: 'https://symon.example/ollama',
  token: 'tok',
  model: 'llama3.2:3b',
  timeoutMs: 1000,
  maxAttempts: 3
};

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify({ response: JSON.stringify(obj) }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

test('ham verdict is parsed and returned', async () => {
  const fetcher: SpamFetcher = async () =>
    jsonResponse({ verdict: 'ham', score: 0.02, reason: 'normal' });
  const v = await classifyComment(
    { authorName: 'A', authorEmail: 'a@e.com', authorUrl: null, body: 'nice post' },
    { ...cfg, fetcher }
  );
  assert.equal(v.verdict, 'ham');
  assert.equal(v.score, 0.02);
});

test('spam verdict is parsed and returned', async () => {
  const fetcher: SpamFetcher = async () =>
    jsonResponse({ verdict: 'spam', score: 0.97, reason: 'links' });
  const v = await classifyComment(
    {
      authorName: 'X',
      authorEmail: 'x@e.com',
      authorUrl: 'http://x',
      body: 'buy now http://a http://b'
    },
    { ...cfg, fetcher }
  );
  assert.equal(v.verdict, 'spam');
});

test('sends bearer token and model to /api/generate', async () => {
  let seenUrl = '';
  let seenAuth: string | null = null;
  let seenModel: unknown;
  const fetcher: SpamFetcher = async (url, init) => {
    seenUrl = url;
    seenAuth = (init?.headers as Record<string, string>)?.authorization ?? null;
    seenModel = JSON.parse(String(init?.body)).model;
    return jsonResponse({ verdict: 'ham', score: 0, reason: 'ok' });
  };
  await classifyComment(
    { authorName: 'A', authorEmail: 'a@e.com', authorUrl: null, body: 'hi' },
    { ...cfg, fetcher }
  );
  assert.equal(seenUrl, 'https://symon.example/ollama/api/generate');
  assert.equal(seenAuth, 'Bearer tok');
  assert.equal(seenModel, 'llama3.2:3b');
});

test('retries on failure up to maxAttempts then throws', async () => {
  let calls = 0;
  const fetcher: SpamFetcher = async () => {
    calls++;
    throw new Error('connection refused');
  };
  await assert.rejects(
    () =>
      classifyComment(
        { authorName: 'A', authorEmail: 'a@e.com', authorUrl: null, body: 'hi' },
        { ...cfg, fetcher }
      ),
    /spam classify failed after 3 attempts/
  );
  assert.equal(calls, 3);
});

test('unparseable model output throws', async () => {
  const fetcher: SpamFetcher = async () =>
    new Response(JSON.stringify({ response: 'not json at all' }), { status: 200 });
  await assert.rejects(
    () =>
      classifyComment(
        { authorName: 'A', authorEmail: 'a@e.com', authorUrl: null, body: 'hi' },
        { ...cfg, fetcher, maxAttempts: 1 }
      ),
    /spam classify failed after 1 attempts/
  );
});

test('HTTP error status throws', async () => {
  const fetcher: SpamFetcher = async () => new Response('Unauthorized', { status: 401 });
  await assert.rejects(
    () =>
      classifyComment(
        { authorName: 'A', authorEmail: 'a@e.com', authorUrl: null, body: 'hi' },
        { ...cfg, fetcher, maxAttempts: 1 }
      ),
    /spam classify failed after 1 attempts/
  );
});

test('missing response field throws', async () => {
  const fetcher: SpamFetcher = async () =>
    new Response(JSON.stringify({ other: 'field' }), { status: 200 });
  await assert.rejects(
    () =>
      classifyComment(
        { authorName: 'A', authorEmail: 'a@e.com', authorUrl: null, body: 'hi' },
        { ...cfg, fetcher, maxAttempts: 1 }
      ),
    /spam classify failed after 1 attempts/
  );
});

test('verdict with no score field defaults based on verdict', async () => {
  const fetcher: SpamFetcher = async () =>
    new Response(
      JSON.stringify({ response: JSON.stringify({ verdict: 'spam', reason: 'no score' }) }),
      { status: 200 }
    );
  const v = await classifyComment(
    { authorName: 'A', authorEmail: 'a@e.com', authorUrl: null, body: 'hi' },
    { ...cfg, fetcher, maxAttempts: 1 }
  );
  assert.equal(v.verdict, 'spam');
  assert.equal(v.score, 1);
});
