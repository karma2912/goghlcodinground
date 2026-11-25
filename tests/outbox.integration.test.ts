// The outbox against a scripted fake Pigeon and real MongoDB/Redis (npm run up).
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

// ---------------------------------------------------------------- fake Pigeon
type Reply = { status: number; body?: unknown; headers?: Record<string, string>; hangMs?: number };
type SendSeen = { key: string | null; clientRef: string; to: string; auth: string | null; at: number };
let seen: SendSeen[] = [];
let script: (req: SendSeen, attempt: number) => Reply = () => ({ status: 200 });

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });

const fake: Server = createServer(async (req, res) => {
  const body = JSON.parse(await readBody(req));
  const s: SendSeen = { key: (req.headers['idempotency-key'] as string) ?? null, clientRef: body.client_ref, to: body.to, auth: req.headers.authorization ?? null, at: Date.now() };
  seen.push(s);
  const r = script(s, seen.filter((x) => x.clientRef === s.clientRef).length);
  if (r.hangMs) await new Promise((x) => setTimeout(x, r.hangMs));
  if (res.destroyed) return;
  res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) });
  res.end(JSON.stringify(r.body ?? { id: `pm_${s.clientRef}`, status: 'accepted' }));
});
await new Promise<void>((r) => fake.listen(0, r));

process.env.PIGEON_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
process.env.MONGO_URL = 'mongodb://localhost:27017/switchboard_test_outbox';
process.env.REDIS_URL = 'redis://localhost:6379/13';
process.env.PIGEON_SEND_TIMEOUT_MS = '300';
process.env.OUTBOX_BACKOFF_BASE_MS = '50';
process.env.OUTBOX_BACKOFF_MAX_MS = '200';
process.env.OUTBOX_POLL_MS = '50';
process.env.PIGEON_RATE_BURST = '100';
process.env.PIGEON_RATE_PER_SEC = '100';

const { config } = await import('../scaffold/server/src/config.js');
const { createApp } = await import('../scaffold/server/src/app.js');
const { initialise } = await import('../scaffold/server/src/health.js');
const { closeDb, messages } = await import('../scaffold/server/src/db.js');
const { closeRedis } = await import('../scaffold/server/src/redis.js');
const { OutboxWorker } = await import('../scaffold/server/src/outbox/worker.js');
const { computeSignature } = await import('../scaffold/server/src/webhooks/signature.js');

// ---------------------------------------------------------------- helpers
let app: Server;
let base: string;
const grader = { 'content-type': 'application/json', 'x-grader-token': config.graderToken };
const quiet = { log: () => {} };
let ref = 0;

async function reply(workspace = 'ws_acme', contact = '+14155550101'): Promise<string> {
  const clientRef = `ref_${Date.now()}_${ref++}`;
  const res = await fetch(base + '/__grader/reply', { method: 'POST', headers: grader, body: JSON.stringify({ workspace, contact, text: 'hello', client_ref: clientRef }) });
  assert.equal(res.status, 202);
  return clientRef;
}

async function outbound(clientRef: string) {
  return (await messages()).findOne({ clientRef });
}

async function statusWebhook(clientRef: string, status: string, workspace = 'ws_acme') {
  const raw = JSON.stringify({ id: `evt_${clientRef}_${status}`, type: 'message.status', workspace, occurred_at: new Date().toISOString(), data: { message_id: `pm_${clientRef}`, client_ref: clientRef, status } });
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${computeSignature(config.pigeon.webhookSecret, t, Buffer.from(raw)).toString('hex')}`;
  const res = await fetch(base + '/webhooks/pigeon', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pigeon-signature': sig }, body: raw });
  return res.status;
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 5000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const accepted = (clientRef: string) => waitFor(async () => {
  const d = await outbound(clientRef);
  return d?.sendState === 'accepted' ? d : null;
});

before(async () => {
  await initialise();
  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});

after(async () => {
  app.close();
  fake.close();
  await closeDb();
  await closeRedis();
});

beforeEach(async () => {
  assert.equal((await fetch(base + '/__grader/reset', { method: 'POST', headers: grader })).status, 200);
  seen = [];
  script = () => ({ status: 200 });
});

// ---------------------------------------------------------------- tests
describe('outbox: sending', () => {
  it('sends a queued reply once, with Idempotency-Key = client_ref and the workspace key', async () => {
    const w = new OutboxWorker(quiet);
    w.start();
    try {
      const r = await reply();
      const doc = await accepted(r);
      assert.equal(doc.pigeonId, `pm_${r}`);
      assert.equal(doc.status, 'queued', 'stays queued until Pigeon says sent');
      await new Promise((x) => setTimeout(x, 200));
      assert.equal(seen.length, 1);
      assert.deepEqual([seen[0].key, seen[0].clientRef, seen[0].to, seen[0].auth], [r, r, '+14155550101', `Bearer ${config.pigeon.apiKeys.ws_acme}`]);
    } finally {
      await w.stop();
    }
  });

  it('retries 503s with backoff, using the same key every time', async () => {
    script = (_s, attempt) => (attempt <= 3 ? { status: 503 } : { status: 200 });
    const w = new OutboxWorker(quiet);
    w.start();
    try {
      const r = await reply();
      const doc = await accepted(r);
      assert.equal(doc.attempts, 4);
      assert.deepEqual(new Set(seen.map((s) => s.key)), new Set([r]));
      const gaps = seen.slice(1).map((s, i) => s.at - seen[i].at);
      assert.ok(gaps.every((g) => g >= 35), `backoff between attempts: ${gaps}`);
    } finally {
      await w.stop();
    }
  });

  it('gives up on a request after the timeout and retries with the same key', async () => {
    script = (_s, attempt) => (attempt === 1 ? { status: 200, hangMs: 1500 } : { status: 200 });
    const w = new OutboxWorker(quiet);
    w.start();
    try {
      const r = await reply();
      await accepted(r);
      assert.equal(seen.length, 2);
      assert.equal(seen[1].key, seen[0].key);
      assert.ok(seen[1].at - seen[0].at >= 300, 'second attempt only after the 300 ms timeout');
    } finally {
      await w.stop();
    }
  });

  it('after a 429 nobody sends to that workspace until Retry-After has passed', async () => {
    script = (_s, attempt) => (attempt === 1 ? { status: 429, headers: { 'retry-after': '1' } } : { status: 200 });
    const w = new OutboxWorker(quiet);
    w.start();
    try {
      const r = await reply();
      await accepted(r);
      assert.equal(seen.length, 2);
      assert.ok(seen[1].at - seen[0].at >= 1000, `waited ${seen[1].at - seen[0].at} ms`);
    } finally {
      await w.stop();
    }
  });

  it('marks a reply failed when Pigeon refuses it (4xx), without retrying', async () => {
    script = () => ({ status: 400, body: { error: 'to and text are required' } });
    const w = new OutboxWorker(quiet);
    w.start();
    try {
      const r = await reply();
      const doc = await waitFor(async () => {
        const d = await outbound(r);
        return d?.sendState === 'rejected' ? d : null;
      });
      assert.equal(doc.status, 'failed');
      await new Promise((x) => setTimeout(x, 300));
      assert.equal(seen.length, 1);
    } finally {
      await w.stop();
    }
  });
});

describe('outbox: leases', () => {
  it('two workers sending 30 replies: each reply is requested exactly once', async () => {
    const a = new OutboxWorker(quiet);
    const b = new OutboxWorker(quiet);
    const refs = await Promise.all(Array.from({ length: 30 }, (_, i) => reply(i % 2 ? 'ws_acme' : 'ws_globex', `+1415555${String(i).padStart(4, '0')}`)));
    a.start();
    b.start();
    try {
      await Promise.all(refs.map(accepted));
      const perRef = new Map<string, number>();
      for (const s of seen) perRef.set(s.clientRef, (perRef.get(s.clientRef) ?? 0) + 1);
      assert.deepEqual([...perRef.values()].filter((n) => n !== 1), []);
      assert.equal(perRef.size, 30);
    } finally {
      await Promise.all([a.stop(), b.stop()]);
    }
  });

  it('a held lease cannot be taken; an expired one is, and the reply is sent', async () => {
    const r = await reply();
    const dead = new OutboxWorker({ ...quiet, leaseMs: 600 });
    const held = await dead.lease(); // a worker that leased it and then died
    assert.equal(held?.clientRef, r);

    const other = new OutboxWorker({ ...quiet, leaseMs: 600 });
    assert.equal(await other.lease(), null, 'lease is held: nobody else gets it');
    other.start();
    try {
      const t0 = Date.now();
      await accepted(r);
      assert.ok(Date.now() - t0 >= 400, 'picked up only after the lease expired');
      assert.equal(seen.length, 1);
    } finally {
      await other.stop();
    }
  });

  it('a worker whose lease was taken over cannot overwrite the new holder', async () => {
    const r = await reply();
    const slow = new OutboxWorker({ ...quiet, leaseMs: 100 });
    const stale = await slow.lease();
    await new Promise((x) => setTimeout(x, 150));
    const fresh = await new OutboxWorker({ ...quiet, leaseMs: 5000 }).lease();
    assert.ok(stale && fresh && stale.leaseToken !== fresh.leaseToken);
    const col = await messages();
    const res = await col.updateOne({ _id: stale._id, leaseToken: stale.leaseToken }, { $set: { lockedUntil: null } });
    assert.equal(res.matchedCount, 0, 'the stale token matches nothing');
    assert.ok((await outbound(r))!.lockedUntil! > new Date(), 'the new lease stands');
  });
});

describe('outbox: status webhooks', () => {
  it('follows queued -> sent -> delivered, and a late sent does not undo delivered', async () => {
    const w = new OutboxWorker(quiet);
    w.start();
    try {
      const r = await reply();
      await accepted(r);
      assert.equal(await statusWebhook(r, 'sent'), 200);
      assert.equal((await outbound(r))!.status, 'sent');
      assert.equal(await statusWebhook(r, 'delivered'), 200);
      assert.equal(await statusWebhook(r, 'sent'), 200); // late duplicate
      assert.equal((await outbound(r))!.status, 'delivered');
    } finally {
      await w.stop();
    }
  });

  it('never overwrites failed with delivered, or delivered with failed', async () => {
    const r1 = await reply();
    const r2 = await reply();
    await statusWebhook(r1, 'failed');
    await statusWebhook(r1, 'delivered');
    await statusWebhook(r2, 'delivered');
    await statusWebhook(r2, 'failed');
    assert.equal((await outbound(r1))!.status, 'failed');
    assert.equal((await outbound(r2))!.status, 'delivered');
  });

  it('a status webhook before the HTTP answer stops the worker sending it again', async () => {
    const r = await reply(); // no worker running: still pending
    await statusWebhook(r, 'delivered');
    const doc = await outbound(r);
    assert.equal(doc!.sendState, 'accepted');
    const w = new OutboxWorker(quiet);
    w.start();
    await new Promise((x) => setTimeout(x, 300));
    await w.stop();
    assert.equal(seen.length, 0);
  });

  it('answers 200 to a status for a reply we never sent', async () => {
    assert.equal(await statusWebhook('never_sent', 'delivered'), 200);
  });

  it('shows the snapshot status per client_ref', async () => {
    const r = await reply();
    await statusWebhook(r, 'delivered');
    const snap = await (await fetch(base + '/__grader/snapshot', { headers: grader })).json();
    assert.equal(snap.workspaces.ws_acme.outbound[r], 'delivered');
  });
});
