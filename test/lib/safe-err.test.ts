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

  it('passes message content through without scrubbing (field-level-only stripping)', () => {
    // We only strip non-allowlisted fields, not message content.
    // If a provider embeds a token in the message string, it still passes through.
    // The protection is refusing to serialize the whole object.
    const err = new Error('code=AUTH_CODE&refresh_token=abc123&client_secret=XYZ');
    const result = safeErr(err);
    assert.equal(result.message, 'code=AUTH_CODE&refresh_token=abc123&client_secret=XYZ');
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
});
