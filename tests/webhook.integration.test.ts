// POST /webhooks/pigeon against real MongoDB and Redis (npm run up).
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

process.env.MONGO_URL = 'mongodb://localhost:27017/switchboard_test_webhook';
process.env.REDIS_URL = 'redis://localhost:6379/14';

const { config } = await import('../scaffold/server/src/config.js');
const { createApp } = await import('../scaffold/server/src/app.js');
const { initialise } = await import('../scaffold/server/src/health.js');
const { closeDb } = await import('../scaffold/server/src/db.js');
const { closeRedis } = await import('../scaffold/server/src/redis.js');
const { computeSignature } = await import('../scaffold/server/src/webhooks/signature.js');

let server: Server;
let base: string;
const grader = { 'content-type': 'application/json', 'x-grader-token': config.graderToken };
const snapshot = async () => (await fetch(base + '/__grader/snapshot', { headers: grader })).json();

let n = 0;
function inbound(workspace: string, from: string, messageId: string, occurredAt: string) {
  return { id: `evt_${++n}`, type: 'message.inbound', workspace, occurred_at: occurredAt, data: { message_id: messageId, from, text: 'hi' } };
}

/** Post like Pigeon: sign the exact bytes sent. */
async function deliver(body: unknown, opts: { secret?: string; t?: number; raw?: string; header?: string | null } = {}) {
  const raw = opts.raw ?? JSON.stringify(body);
  const t = opts.t ?? Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${computeSignature(opts.secret ?? config.pigeon.webhookSecret, t, Buffer.from(raw)).toString('hex')}`;
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-pigeon-event-id': 'evt_test' };
  if (opts.header !== null) headers['x-pigeon-signature'] = opts.header ?? sig;
  const res = await fetch(base + '/webhooks/pigeon', { method: 'POST', headers, body: raw });
  return res.status;
}

before(async () => {
  await initialise();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  await closeDb();
  await closeRedis();
});

beforeEach(async () => {
  assert.equal((await fetch(base + '/__grader/reset', { method: 'POST', headers: grader })).status, 200);
});

describe('POST /webhooks/pigeon: rejections', () => {
  const ev = () => inbound('ws_acme', '+14155550101', `pmsg_${n}`, new Date().toISOString());

  it('401 without a signature', async () => assert.equal(await deliver(ev(), { header: null }), 401));
  it('401 for a malformed signature', async () => assert.equal(await deliver(ev(), { header: 't=now,v1=zz' }), 401));
  it('401 for a forged signature', async () => assert.equal(await deliver(ev(), { secret: 'not-the-secret' }), 401));
  it('401 for a replay an hour old', async () => assert.equal(await deliver(ev(), { t: Math.floor(Date.now() / 1000) - 3600 }), 401));
  it('401 for a timestamp 10 minutes in the future', async () => assert.equal(await deliver(ev(), { t: Math.floor(Date.now() / 1000) + 600 }), 401));
  it('200 for a timestamp 4 minutes old (slow network)', async () => assert.equal(await deliver(ev(), { t: Math.floor(Date.now() / 1000) - 240 }), 200));
  it('400 for a signed body that is not JSON', async () => assert.equal(await deliver(null, { raw: '{not json' }), 400));
  it('400 for a signed inbound event without data', async () => assert.equal(await deliver(null, { raw: '{"type":"message.inbound","workspace":"ws_acme"}' }), 400));
  it('401 wins over 400: an unsigned bad body is 401', async () => assert.equal(await deliver(null, { raw: '{not json', header: null }), 401));

  it('stores nothing that was rejected', async () => {
    await deliver(ev(), { secret: 'not-the-secret' });
    await deliver(ev(), { t: Math.floor(Date.now() / 1000) - 3600 });
    const snap = await snapshot();
    assert.deepEqual(snap.workspaces.ws_acme.contacts, {});
  });
});

describe('POST /webhooks/pigeon: acknowledged and ignored', () => {
  it('200 for an unknown event type', async () => {
    assert.equal(await deliver({ id: 'e', type: 'contact.typing', workspace: 'ws_acme', data: {} }), 200);
  });
  it('200 for a status of a message we never sent', async () => {
    assert.equal(await deliver({ id: 'e', type: 'message.status', workspace: 'ws_acme', data: { message_id: 'pm_x', client_ref: 'never', status: 'sent' } }), 200);
  });
  it('200 for an unknown workspace, and nothing is stored', async () => {
    assert.equal(await deliver(inbound('ws_nope', '+1', 'pmsg_nope', new Date().toISOString())), 200);
    const snap = await snapshot();
    assert.equal(snap.workspaces.ws_nope, undefined);
  });
});

describe('POST /webhooks/pigeon: storing', () => {
  it('stores a message under its workspace and contact, once, however often it arrives', async () => {
    const ev = inbound('ws_acme', '+14155550101', 'pmsg_once', new Date().toISOString());
    const statuses = await Promise.all(Array.from({ length: 5 }, () => deliver(ev)));
    assert.deepEqual(statuses, [200, 200, 200, 200, 200]);
    const snap = await snapshot();
    assert.deepEqual(snap.workspaces.ws_acme.contacts['+14155550101'].inbound, ['pmsg_once']);
    assert.deepEqual(snap.workspaces.ws_globex.contacts, {});
  });

  it('orders by occurred_at, not by arrival', async () => {
    const t = Date.now();
    const at = (ms: number) => new Date(t + ms).toISOString();
    await deliver(inbound('ws_globex', '+442079460201', 'pmsg_c', at(300)));
    await deliver(inbound('ws_globex', '+442079460201', 'pmsg_a', at(0)));
    await deliver(inbound('ws_globex', '+442079460201', 'pmsg_b', at(150)));
    const snap = await snapshot();
    assert.deepEqual(snap.workspaces.ws_globex.contacts['+442079460201'].inbound, ['pmsg_a', 'pmsg_b', 'pmsg_c']);
  });

  it('keeps contacts and workspaces apart', async () => {
    const at = new Date().toISOString();
    await deliver(inbound('ws_acme', '+14155550101', 'pmsg_1', at));
    await deliver(inbound('ws_acme', '+14155550102', 'pmsg_2', at));
    await deliver(inbound('ws_globex', '+442079460201', 'pmsg_3', at));
    const snap = await snapshot();
    assert.deepEqual(snap.workspaces.ws_acme.contacts['+14155550101'].inbound, ['pmsg_1']);
    assert.deepEqual(snap.workspaces.ws_acme.contacts['+14155550102'].inbound, ['pmsg_2']);
    assert.deepEqual(Object.keys(snap.workspaces.ws_globex.contacts), ['+442079460201']);
  });

  it('a message from a contact creates an open, unassigned conversation', async () => {
    await deliver(inbound('ws_acme', '+13035550106', 'pmsg_new', new Date().toISOString()));
    const snap = await snapshot();
    assert.equal(snap.workspaces.ws_acme.contacts['+13035550106'].assignee, null);
  });
});
