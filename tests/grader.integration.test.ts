// The grader endpoints against real MongoDB and Redis (npm run up).
// Uses its own database and Redis db so it never touches dev data.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

process.env.MONGO_URL = 'mongodb://localhost:27017/switchboard_test';
process.env.REDIS_URL = 'redis://localhost:6379/15';

// Imported after the env is set: config reads it at load time.
const { config } = await import('../scaffold/server/src/config.js');
const { createApp } = await import('../scaffold/server/src/app.js');
const { initialise } = await import('../scaffold/server/src/health.js');
const { closeDb } = await import('../scaffold/server/src/db.js');
const { closeRedis, getRedis, APP_PREFIX, SESSION_PREFIX } = await import('../scaffold/server/src/redis.js');

let server: Server;
let base: string;
const auth = { 'content-type': 'application/json', 'x-grader-token': config.graderToken };
const post = (path: string, body: unknown, headers: Record<string, string> = auth) =>
  fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
const snapshot = async () => (await fetch(base + '/__grader/snapshot', { headers: auth })).json();

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
  assert.equal((await post('/__grader/reset', {})).status, 200);
});

describe('GET /healthz', () => {
  it('answers 200 when MongoDB and Redis are up', async () => {
    const res = await fetch(base + '/healthz');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, initialised: true, mongo: true, redis: true });
  });
});

describe('grader token', () => {
  for (const [name, headers] of [
    ['missing', { 'content-type': 'application/json' }],
    ['wrong', { 'content-type': 'application/json', 'x-grader-token': 'nope' }],
  ] as const) {
    it(`answers 401 when the token is ${name}`, async () => {
      assert.equal((await post('/__grader/reset', {}, headers)).status, 401);
      assert.equal((await fetch(base + '/__grader/snapshot', { headers })).status, 401);
      assert.equal((await post('/__grader/reply', {}, headers)).status, 401);
      assert.equal((await post('/__grader/claim', {}, headers)).status, 401);
    });
  }
});

describe('POST /__grader/reply', () => {
  it('stores a reply as queued and creates the conversation', async () => {
    const res = await post('/__grader/reply', { workspace: 'ws_acme', contact: '+14155550101', text: 'hi', client_ref: 'r1' });
    assert.equal(res.status, 202);
    const snap = await snapshot();
    assert.deepEqual(snap.workspaces.ws_acme.outbound, { r1: 'queued' });
    assert.deepEqual(snap.workspaces.ws_acme.contacts['+14155550101'], { inbound: [], assignee: null });
  });

  it('treats the same client_ref sent concurrently as one reply, all 202', async () => {
    const body = { workspace: 'ws_acme', contact: '+14155550102', text: 'once', client_ref: 'same' };
    const statuses = await Promise.all(Array.from({ length: 8 }, () => post('/__grader/reply', body).then((r) => r.status)));
    assert.deepEqual(statuses, Array(8).fill(202));
    const snap = await snapshot();
    assert.deepEqual(snap.workspaces.ws_acme.outbound, { same: 'queued' });
  });

  it('answers 4xx for an unknown workspace and for a bad body', async () => {
    const unknown = await post('/__grader/reply', { workspace: 'ws_nope', contact: '+1', text: 'x', client_ref: 'r' });
    assert.equal(unknown.status, 404);
    assert.equal((await post('/__grader/reply', { workspace: 'ws_acme' })).status, 400);
    const malformed = await fetch(base + '/__grader/reply', { method: 'POST', headers: auth, body: '{not json' });
    assert.equal(malformed.status, 400);
  });
});

describe('POST /__grader/claim', () => {
  it('lets exactly one of six simultaneous agents win, and the snapshot agrees', async () => {
    const contacts = ['+442079460201', '+442079460202', '+442079460203'];
    for (const contact of contacts) {
      const statuses = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          post('/__grader/claim', { workspace: 'ws_globex', contact, agent: `agent_${i}` }).then(async (r) => ({ status: r.status, agent: `agent_${i}` })),
        ),
      );
      const winners = statuses.filter((s) => s.status === 200);
      assert.equal(winners.length, 1, `exactly one winner for ${contact}`);
      assert.equal(statuses.filter((s) => s.status === 409).length, 5);
      const snap = await snapshot();
      assert.equal(snap.workspaces.ws_globex.contacts[contact].assignee, winners[0].agent);
    }
  });

  it('gives the holder 200 again and anyone else 409', async () => {
    const body = { workspace: 'ws_acme', contact: '+14155550103', agent: 'u_ben' };
    assert.equal((await post('/__grader/claim', body)).status, 200);
    assert.equal((await post('/__grader/claim', body)).status, 200);
    assert.equal((await post('/__grader/claim', { ...body, agent: 'u_eli' })).status, 409);
  });

  it('can claim a conversation that a reply created', async () => {
    await post('/__grader/reply', { workspace: 'ws_acme', contact: '+12125550104', text: 'hi', client_ref: 'c1' });
    assert.equal((await post('/__grader/claim', { workspace: 'ws_acme', contact: '+12125550104', agent: 'u_ben' })).status, 200);
  });

  it('answers 404 for an unknown workspace', async () => {
    assert.equal((await post('/__grader/claim', { workspace: 'ws_nope', contact: '+1', agent: 'a' })).status, 404);
  });
});

describe('POST /__grader/reset', () => {
  it('deletes app data in MongoDB and Redis but keeps sessions', async () => {
    await post('/__grader/reply', { workspace: 'ws_acme', contact: '+14155550101', text: 'hi', client_ref: 'x' });
    const r = getRedis();
    await r.set(APP_PREFIX + 'probe', '1');
    await r.set(SESSION_PREFIX + 'probe', '1');
    assert.equal((await post('/__grader/reset', {})).status, 200);
    const snap = await snapshot();
    assert.deepEqual(snap.workspaces.ws_acme, { contacts: {}, outbound: {} });
    assert.equal(await r.get(APP_PREFIX + 'probe'), null);
    assert.equal(await r.get(SESSION_PREFIX + 'probe'), '1');
    await r.del(SESSION_PREFIX + 'probe');
  });
});
