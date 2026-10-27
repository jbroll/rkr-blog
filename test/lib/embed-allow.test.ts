import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMBED_FRAME_SRC, embedAllowed, toEmbedUrl } from '../../src/lib/embed-allow.ts';

test('embedAllowed: maps embed yes, google search no, youtube.com watch no', () => {
  assert.equal(embedAllowed('https://www.google.com/maps/embed?pb=1'), true);
  assert.equal(embedAllowed('https://www.google.com/maps/embed/v1/place'), true);
  assert.equal(embedAllowed('https://www.google.com/maps/embedded'), false);
  assert.equal(embedAllowed('https://www.google.com/search?q=x'), false);
  assert.equal(embedAllowed('https://www.youtube.com/watch?v=abc'), false);
  assert.equal(embedAllowed('https://www.youtube-nocookie.com/embed/abc'), true);
  assert.equal(embedAllowed('https://player.vimeo.com/video/1'), true);
  assert.equal(embedAllowed('https://docs.google.com/forms/d/e/X/viewform'), true);
  assert.equal(embedAllowed('http://docs.google.com/forms'), false);
  assert.equal(embedAllowed('https://docs.google.com.evil.test/'), false);
  assert.equal(embedAllowed('https://user@docs.google.com/'), false);
  assert.equal(embedAllowed('not a url'), false);
});

test('embedAllowed refuses lookalike hosts and ports', () => {
  assert.equal(embedAllowed('https://docs.google.com@evil.test/'), false);
  assert.equal(embedAllowed('https://evil.test/?docs.google.com'), false);
  assert.equal(embedAllowed('https://docs.google.com:8443/'), false);
  assert.equal(embedAllowed('https://docs.google.com:443/'), true);
});

function cspMatches(source: string, url: string): boolean {
  const u = new URL(url);
  const s = new URL(source);
  if (u.protocol !== s.protocol || u.host !== s.host) return false;
  if (s.pathname === '/') return true;
  return s.pathname.endsWith('/') ? u.pathname.startsWith(s.pathname) : u.pathname === s.pathname;
}

test('every URL embedAllowed accepts matches a frame-src source', () => {
  const urls = [
    'https://docs.google.com/forms/d/e/X/viewform?embedded=true',
    'https://www.youtube-nocookie.com/embed/abc',
    'https://player.vimeo.com/video/1',
    'https://www.google.com/maps/embed?pb=1',
    'https://www.google.com/maps/embed/v1/place?key=k'
  ];
  for (const url of urls) {
    assert.equal(embedAllowed(url), true, url);
    assert.ok(
      EMBED_FRAME_SRC.split(' ').some((s) => cspMatches(s, url)),
      `no frame-src source matches ${url}`
    );
  }
});

test('toEmbedUrl rewrites youtube, youtu.be, vimeo and Google Form share links', () => {
  assert.equal(toEmbedUrl('https://youtu.be/abc'), 'https://www.youtube-nocookie.com/embed/abc');
  assert.equal(
    toEmbedUrl('https://www.youtube.com/watch?v=abc&t=3'),
    'https://www.youtube-nocookie.com/embed/abc'
  );
  assert.equal(
    toEmbedUrl('https://www.youtube.com/embed/abc'),
    'https://www.youtube-nocookie.com/embed/abc'
  );
  assert.equal(toEmbedUrl('https://vimeo.com/123'), 'https://player.vimeo.com/video/123');
  assert.match(
    toEmbedUrl('https://docs.google.com/forms/d/e/X/viewform')!,
    /viewform\?embedded=true$/
  );
  assert.match(
    toEmbedUrl('https://docs.google.com/forms/d/e/X/viewform?usp=sf_link')!,
    /embedded=true$/
  );
  assert.equal(toEmbedUrl('https://evil.test/'), null);
  assert.equal(toEmbedUrl('https://www.youtube.com/watch'), null);
  assert.equal(toEmbedUrl('https://youtu.be/'), null);
  assert.equal(toEmbedUrl('https://vimeo.com/channels/x'), null);
  assert.equal(toEmbedUrl('javascript:alert(1)'), null);
  assert.equal(
    toEmbedUrl('https://www.google.com/maps/embed?pb=1'),
    'https://www.google.com/maps/embed?pb=1'
  );
});

test('frame-src source list lists the allowed origins', () => {
  assert.equal(EMBED_FRAME_SRC.split(' ').length, 5);
});
