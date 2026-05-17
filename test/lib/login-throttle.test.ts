// Shared per-IP failed-credential tally. Drives both the browser
// token-login route and the bearer-header middleware. The window/
// ceiling semantics MUST match the values previously inlined in
// src/routes/auth.ts (ceiling 5, window 5 minutes) so the browser
// route's behavior is unchanged after the refactor.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  _loginThrottleSize,
  _resetLoginThrottle,
  clearFailures,
  DEFAULT_MAX,
  isThrottled,
  recordFailure,
  WINDOW_MS
} from '../../src/lib/login-throttle.ts';

afterEach(() => _resetLoginThrottle());

test('below the ceiling: not throttled', () => {
  for (let i = 0; i < DEFAULT_MAX - 1; i++) recordFailure('1.2.3.4');
  assert.equal(isThrottled('1.2.3.4'), false);
});

test('at the ceiling: throttled', () => {
  for (let i = 0; i < DEFAULT_MAX; i++) recordFailure('1.2.3.4');
  assert.equal(isThrottled('1.2.3.4'), true);
});

test('over the ceiling: still throttled', () => {
  for (let i = 0; i < DEFAULT_MAX + 5; i++) recordFailure('1.2.3.4');
  assert.equal(isThrottled('1.2.3.4'), true);
});

test('a fresh ip is never throttled', () => {
  recordFailure('9.9.9.9');
  assert.equal(isThrottled('5.5.5.5'), false);
});

test('explicit max override (e2e runner raises the cap)', () => {
  for (let i = 0; i < DEFAULT_MAX; i++) recordFailure('1.2.3.4');
  // At DEFAULT_MAX failures, the default ceiling is hit but a higher
  // explicit cap (the e2e runner passes 100) is not.
  assert.equal(isThrottled('1.2.3.4'), true);
  assert.equal(isThrottled('1.2.3.4', 100), false);
});

test('window expiry resets the tally', () => {
  const realNow = Date.now;
  try {
    let t = 1_000_000;
    Date.now = () => t;
    for (let i = 0; i < DEFAULT_MAX; i++) recordFailure('1.2.3.4');
    assert.equal(isThrottled('1.2.3.4'), true);
    // Advance past the window — the next check sees a stale window
    // and treats the ip as clean again.
    t += WINDOW_MS + 1;
    assert.equal(isThrottled('1.2.3.4'), false);
    // A failure after expiry starts a brand-new window.
    recordFailure('1.2.3.4');
    assert.equal(isThrottled('1.2.3.4'), false);
  } finally {
    Date.now = realNow;
  }
});

test('recordFailure after window expiry starts a fresh window', () => {
  const realNow = Date.now;
  try {
    let t = 2_000_000;
    Date.now = () => t;
    for (let i = 0; i < DEFAULT_MAX; i++) recordFailure('7.7.7.7');
    t += WINDOW_MS + 1;
    // First failure in the new window: count back to 1, not throttled.
    recordFailure('7.7.7.7');
    assert.equal(isThrottled('7.7.7.7'), false);
    for (let i = 0; i < DEFAULT_MAX - 1; i++) recordFailure('7.7.7.7');
    assert.equal(isThrottled('7.7.7.7'), true);
  } finally {
    Date.now = realNow;
  }
});

test('clearFailures drops the ip tally', () => {
  for (let i = 0; i < DEFAULT_MAX; i++) recordFailure('1.2.3.4');
  assert.equal(isThrottled('1.2.3.4'), true);
  clearFailures('1.2.3.4');
  assert.equal(isThrottled('1.2.3.4'), false);
});

test('clearFailures on an unknown ip is a no-op', () => {
  clearFailures('never.seen');
  assert.equal(isThrottled('never.seen'), false);
});

test('_resetLoginThrottle wipes all ip tallies', () => {
  for (let i = 0; i < DEFAULT_MAX; i++) recordFailure('a');
  for (let i = 0; i < DEFAULT_MAX; i++) recordFailure('b');
  _resetLoginThrottle();
  assert.equal(isThrottled('a'), false);
  assert.equal(isThrottled('b'), false);
});

test('recordFailure sweeps expired entries when opening a new window', () => {
  // IP-A records failures to create a window entry.
  const realNow = Date.now;
  try {
    let t = 3_000_000;
    Date.now = () => t;
    recordFailure('ip-a');
    assert.equal(_loginThrottleSize(), 1);

    // Advance past the window so IP-A's entry is expired.
    t += WINDOW_MS + 1;

    // IP-B recording a failure opens a new window, triggering the sweep.
    recordFailure('ip-b');

    // Sweep must have removed the expired IP-A entry; only IP-B remains.
    assert.equal(_loginThrottleSize(), 1);

    // IP-A is no longer throttled and starts fresh (count 0, no window).
    assert.equal(isThrottled('ip-a'), false);
    // One more failure for IP-A starts a brand-new window at count 1.
    recordFailure('ip-a');
    assert.equal(isThrottled('ip-a'), false); // count 1, below ceiling
  } finally {
    Date.now = realNow;
  }
});
