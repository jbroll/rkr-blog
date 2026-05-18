import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { safeErr } from '../../src/lib/safe-err.ts';

describe('safeErr', () => {
  it('extracts name, message, code from an Error object', () => {
    const err = Object.assign(new Error('something went wrong'), { code: 'ERR_BAD' });
    const result = safeErr(err);
    assert.deepEqual(result, {
      name: 'Error',
      message: 'something went wrong',
      code: 'ERR_BAD'
    });
  });

  it('omits non-allowlisted fields (response, body, cause, config, etc.)', () => {
    const err = Object.assign(new Error('fetch failed'), {
      code: 'ERR_FETCH',
      response: { status: 400, body: 'client_secret=LEAKED' },
      body: 'refresh_token=SUPERSECRET',
      cause: new Error('inner'),
      config: { headers: { Authorization: 'Bearer token123' } }
    });
    const result = safeErr(err);
    assert.deepEqual(result, {
      name: 'Error',
      message: 'fetch failed',
      code: 'ERR_FETCH'
    });
    assert.equal('response' in result, false);
    assert.equal('body' in result, false);
    assert.equal('cause' in result, false);
    assert.equal('config' in result, false);
  });

  it('redacts secret key=value pairs from message content', () => {
    // safeErr now redacts secret patterns from message in addition to stripping fields.
    const err = new Error('code=AUTH_CODE&refresh_token=abc123&client_secret=XYZ');
    const result = safeErr(err);
    assert.doesNotMatch(result.message ?? '', /AUTH_CODE|abc123|XYZ/);
    assert.equal(result.name, 'Error');
  });

  it('handles a plain object with name/message/code', () => {
    const err = { name: 'OAuthError', message: 'invalid_grant', code: '400' };
    assert.deepEqual(safeErr(err), { name: 'OAuthError', message: 'invalid_grant', code: '400' });
  });

  it('handles an object with missing fields — omits undefined keys', () => {
    const err = { message: 'only message here' };
    const result = safeErr(err);
    assert.equal(result.message, 'only message here');
    assert.equal(result.name, undefined);
    assert.equal(result.code, undefined);
  });

  it('handles a non-string, non-object code field gracefully', () => {
    const err = { message: 'bad', code: 42 };
    const result = safeErr(err);
    assert.equal(result.code, undefined);
  });

  it('handles a string error', () => {
    assert.deepEqual(safeErr('something bad'), { message: 'something bad' });
  });

  it('handles null', () => {
    assert.deepEqual(safeErr(null), { message: undefined });
  });

  it('handles undefined', () => {
    assert.deepEqual(safeErr(undefined), { message: undefined });
  });

  it('handles a number', () => {
    assert.deepEqual(safeErr(42), { message: undefined });
  });

  it('safeErr redacts token/secret patterns embedded in message', () => {
    const e = new Error(
      'exchange failed: code=AUTHCODE123 refresh_token=rt_secret access_token=at_secret client_secret=cs_secret'
    );
    const s = safeErr(e);
    assert.doesNotMatch(s.message ?? '', /AUTHCODE123|rt_secret|at_secret|cs_secret/);
    assert.match(s.message ?? '', /exchange failed/); // non-secret context preserved
  });

  it('safeErr redacts a long opaque token-like run', () => {
    const e = new Error(
      'jwt rejected: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbb'
    );
    assert.doesNotMatch(safeErr(e).message ?? '', /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/);
  });

  it('safeErr still returns only name/message/code (no extra fields)', () => {
    const e = Object.assign(new Error('boom'), {
      response: { token: 'leak' },
      code: 'EBADR',
      config: { x: 1 }
    });
    assert.deepEqual(safeErr(e), { name: 'Error', message: 'boom', code: 'EBADR' });
  });

  it('safeErr string branch is also redacted', () => {
    assert.doesNotMatch(safeErr('failed access_token=zzz').message ?? '', /zzz/);
  });

  it('a benign message is unchanged', () => {
    assert.equal(safeErr(new Error('post not found')).message, 'post not found');
  });

  it('safeErr redacts the token after Authorization: Bearer (short token)', () => {
    const s = safeErr(new Error('upstream rejected Authorization: Bearer short_tok_123 (401)'));
    assert.doesNotMatch(s.message ?? '', /short_tok_123/);
    assert.match(s.message ?? '', /upstream rejected/); // benign context kept
  });

  it('safeErr redacts a lowercase bearer token form', () => {
    assert.doesNotMatch(safeErr('fetch failed: bearer abcDEF12').message ?? '', /abcDEF12/);
  });
});
