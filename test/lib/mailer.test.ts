import assert from 'node:assert/strict';
import { test } from 'node:test';

import { envMailer, makeMailer } from '../../src/lib/mailer.ts';

test('envMailer no-ops (sent:false) when SMTP env is unset', async () => {
  const prev = { h: process.env.SMTP_HOST, t: process.env.NOTIFY_TO };
  delete process.env.SMTP_HOST;
  delete process.env.NOTIFY_TO;
  try {
    const r = await envMailer().sendMail({ to: 'x', subject: 's', text: 't' });
    assert.deepEqual(r, { sent: false });
  } finally {
    if (prev.h !== undefined) process.env.SMTP_HOST = prev.h;
    if (prev.t !== undefined) process.env.NOTIFY_TO = prev.t;
  }
});

test('no-op + sent:false when unconfigured', async () => {
  const m = makeMailer({ host: undefined, to: undefined }, async () => {
    throw new Error('transport must not be called when unconfigured');
  });
  assert.deepEqual(await m.sendMail({ to: 'x', subject: 's', text: 't' }), {
    sent: false
  });
});

test('configured: calls transport with the message, returns sent:true', async () => {
  const calls: unknown[] = [];
  const m = makeMailer(
    { host: 'smtp.example', port: 587, from: 'a@b', to: 'owner@b' },
    async (msg) => {
      calls.push(msg);
    }
  );
  const r = await m.sendMail({ to: 'owner@b', subject: 'S', text: 'B' });
  assert.deepEqual(r, { sent: true });
  assert.equal(calls.length, 1);
  assert.match(JSON.stringify(calls[0]), /"subject":"S"/);
});

test('transport throw is swallowed → sent:false (never throws)', async () => {
  const m = makeMailer({ host: 'h', to: 'o' }, async () => {
    throw new Error('smtp down');
  });
  assert.deepEqual(await m.sendMail({ to: 'o', subject: 's', text: 't' }), {
    sent: false
  });
});
