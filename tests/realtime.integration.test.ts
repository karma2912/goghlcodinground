// GET /ws: auth, live frames, seq, replay, and two instances sharing Redis.
// Needs MongoDB, Redis and the mock IdP (npm run up). Uses Node's built-in
// WebSocket, as level 5 of the check does.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

process.env.MONGO_URL = 'mongodb://localhost:27017/switchboard_test_realtime';
process.env.REDIS_URL = 'redis://localhost:6379/10';

const { config } = await import('../scaffold/server/src/config.js');
const { createApp } = await import('../scaffold/server/src/app.js');
const { initialise } = await import('../scaffold/server/src/health.js');
const { closeDb, messages } = await import('../scaffold/server/src/db.js');
const { closeRedis } = await import('../scaffold/server/src/redis.js');
const { attachRealtime } = await import('../scaffold/server/src/realtime/server.js');
const { computeSignature } = await import('../scaffold/server/src/webhooks/signature.js');

// Two instances of the app, like two copies behind the load balancer.
type Instance = { server: Server; base: string; port: number; close: () => Promise<void> };
async function startInstance(): Promise<Instance> {
  const server = createServer(createApp());
  const rt = await attachRealtime(server);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  return { server, port, base: `http://127.0.0.1:${port}`, close: async () => { await rt.close(); server.close(); } };
}
let A: Instance;
let B: Instance;
const grader = { 'content-type': 'application/json', 'x-grader-token': config.graderToken };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- helpers
async function signIn(sub: string, base = A.base): Promise<string> {
  const jar = new Map<string, string>();
  const keep = (res: Response) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
  };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const start = await fetch(base + '/auth/login', { redirect: 'manual' });
  keep(start);
  const idp = await fetch(start.headers.get('location') + '&login=' + sub, { redirect: 'manual' });
  const back = new URL(idp.headers.get('location')!);
  const done = await fetch(base + back.pathname + back.search, { redirect: 'manual', headers: { cookie: cookie() } });
  keep(done);
  assert.equal(done.status, 302);
  return `sb_session=${jar.get('sb_session')}`;
}

type Frame = { seq?: number; type: string; [k: string]: unknown };
type Sock = { opened: boolean; frames: Frame[]; ws: WebSocket; closed: Promise<number> };
function openSocket(inst: Instance, query: string, headers: Record<string, string> = {}): Promise<Sock> {
  return new Promise((resolve) => {
    // Node's WebSocket (undici) accepts headers here, which is how the check sends its cookie.
    const ws = new WebSocket(`ws://127.0.0.1:${inst.port}/ws?${query}`, { headers } as never);
    const frames: Frame[] = [];
    let settled = false;
    let onClose: (code: number) => void = () => {};
    const closed = new Promise<number>((r) => (onClose = r));
    const done = (opened: boolean) => {
      if (!settled) (settled = true), resolve({ opened, frames, ws, closed });
    };
    ws.addEventListener('open', () => done(true));
    ws.addEventListener('error', () => done(false));
    ws.addEventListener('close', (e) => {
      onClose(e.code);
      done(false);
    });
    ws.addEventListener('message', (m) => frames.push(JSON.parse(String(m.data))));
    setTimeout(() => done(false), 5000);
  });
}

async function webhook(inst: Instance, body: object) {
  const raw = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${computeSignature(config.pigeon.webhookSecret, t, Buffer.from(raw)).toString('hex')}`;
  const res = await fetch(inst.base + '/webhooks/pigeon', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pigeon-signature': sig }, body: raw });
  assert.equal(res.status, 200);
}
let n = 0;
const inbound = (workspace: string, from: string, id = `pmsg_rt_${++n}`) => ({ id: `evt_${id}`, type: 'message.inbound', workspace, occurred_at: new Date().toISOString(), data: { message_id: id, from, text: `hello ${id}` } });
const post = (inst: Instance, path: string, body: object) => fetch(inst.base + path, { method: 'POST', headers: grader, body: JSON.stringify(body) });

async function waitFrames(s: Sock, count: number, type?: string, ms = 5000): Promise<Frame[]> {
  const until = Date.now() + ms;
  const pick = () => s.frames.filter((f) => typeof f.seq === 'number' && (!type || f.type === type));
  while (pick().length < count) {
    if (Date.now() > until) throw new Error(`waited ${ms} ms for ${count} ${type ?? ''} frames, got ${pick().length}`);
    await sleep(20);
  }
  return pick();
}
const rising = (fs: Frame[]) => fs.every((f, i) => i === 0 || f.seq! > fs[i - 1].seq!);

let ben: string;
let open: Sock[] = [];
const track = async (p: Promise<Sock>) => {
  const s = await p;
  open.push(s);
  return s;
};

before(async () => {
  await initialise();
  A = await startInstance();
  B = await startInstance();
  ben = await signIn('u_ben');
});

after(async () => {
  for (const s of open) s.ws.close();
  await A.close();
  await B.close();
  await closeDb();
  await closeRedis();
});

beforeEach(async () => {
  for (const s of open) s.ws.close();
  open = [];
  assert.equal((await post(A, '/__grader/reset', {})).status, 200);
});

// ---------------------------------------------------------------- tests
describe('GET /ws: who may connect', () => {
  it('opens for a member of the workspace', async () => {
    assert.equal((await track(openSocket(A, 'workspace=ws_acme', { cookie: ben }))).opened, true);
  });

  for (const [name, query, headers] of [
    ['no session', 'workspace=ws_acme', {}],
    ['a made-up session', 'workspace=ws_acme', { cookie: `sb_session=${'A'.repeat(43)}` }],
    ['a workspace the user is not in', 'workspace=ws_globex', 'BEN'],
    ['no workspace', '', 'BEN'],
    ['a bad after', 'workspace=ws_acme&after=abc', 'BEN'],
    ['a foreign Origin (cross-site WebSocket hijacking)', 'workspace=ws_acme', 'BEN_EVIL'],
  ] as const) {
    it(`refuses ${name}`, async () => {
      const h = headers === 'BEN' ? { cookie: ben } : headers === 'BEN_EVIL' ? { cookie: ben, origin: 'http://evil.test' } : headers;
      assert.equal((await track(openSocket(A, query, h as Record<string, string>))).opened, false);
    });
  }

  it("allows the web app's own Origin", async () => {
    assert.equal((await track(openSocket(A, 'workspace=ws_acme', { cookie: ben, origin: new URL(config.webOrigin).origin }))).opened, true);
  });
});

describe('GET /ws: live frames', () => {
  it('a new inbound message arrives within 5 s, with seq; another workspace never leaks in', async () => {
    const s = await track(openSocket(A, 'workspace=ws_acme', { cookie: ben }));
    const t0 = Date.now();
    await webhook(A, inbound('ws_globex', '+442079460201', 'pmsg_globex_secret'));
    await webhook(A, inbound('ws_acme', '+14155550101', 'pmsg_live'));
    const [f] = await waitFrames(s, 1, 'message.inbound');
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(f.message_id, 'pmsg_live');
    assert.equal(f.contact, '+14155550101');
    assert.equal(typeof f.seq, 'number');
    await sleep(300);
    assert.equal(s.frames.filter((x) => x.message_id === 'pmsg_globex_secret').length, 0);
  });

  it('a message delivered five times at once makes exactly one frame', async () => {
    const s = await track(openSocket(A, 'workspace=ws_acme', { cookie: ben }));
    const ev = inbound('ws_acme', '+14155550102', 'pmsg_dup');
    await Promise.all([webhook(A, ev), webhook(B, ev), webhook(A, ev), webhook(B, ev), webhook(A, ev)]);
    await waitFrames(s, 1, 'message.inbound');
    await sleep(500);
    assert.equal(s.frames.filter((f) => f.message_id === 'pmsg_dup').length, 1);
  });

  it('a socket on one instance receives what another instance processed', async () => {
    const onB = await track(openSocket(B, 'workspace=ws_acme', { cookie: ben }));
    await webhook(A, inbound('ws_acme', '+14155550103', 'pmsg_cross'));
    const [f] = await waitFrames(onB, 1, 'message.inbound');
    assert.equal(f.message_id, 'pmsg_cross');
  });

  it('20 messages at once across two instances: seq strictly rises, and both sockets see the same sequence', async () => {
    const onA = await track(openSocket(A, 'workspace=ws_acme', { cookie: ben }));
    const onB = await track(openSocket(B, 'workspace=ws_acme', { cookie: ben }));
    await Promise.all(Array.from({ length: 20 }, (_, i) => webhook(i % 2 ? A : B, inbound('ws_acme', '+14155550101'))));
    const fa = await waitFrames(onA, 20, 'message.inbound');
    const fb = await waitFrames(onB, 20, 'message.inbound');
    assert.ok(rising(onA.frames.filter((f) => f.seq !== undefined)), 'seq rises on A');
    assert.deepEqual(fa.map((f) => [f.seq, f.message_id]), fb.map((f) => [f.seq, f.message_id]));
    assert.equal(new Set(fa.map((f) => f.message_id)).size, 20);
  });

  it('reports replies, statuses, assignments and close/reopen', async () => {
    const s = await track(openSocket(A, 'workspace=ws_acme', { cookie: ben }));
    const contact = '+12125550104';
    assert.equal((await post(A, '/__grader/reply', { workspace: 'ws_acme', contact, text: 'hi', client_ref: 'rt_ref' })).status, 202);
    await webhook(B, { id: 'evt_st', type: 'message.status', workspace: 'ws_acme', occurred_at: new Date().toISOString(), data: { message_id: 'pm_1', client_ref: 'rt_ref', status: 'delivered' } });
    await webhook(B, { id: 'evt_st2', type: 'message.status', workspace: 'ws_acme', occurred_at: new Date().toISOString(), data: { message_id: 'pm_1', client_ref: 'rt_ref', status: 'sent' } }); // late: no frame
    assert.equal((await post(B, '/__grader/claim', { workspace: 'ws_acme', contact, agent: 'u_ben' })).status, 200);
    assert.equal((await post(A, '/__grader/claim', { workspace: 'ws_acme', contact, agent: 'u_ben' })).status, 200); // holder again: no frame
    const c = encodeURIComponent(contact);
    await fetch(`${A.base}/api/conversations/${c}/close?workspace=ws_acme`, { method: 'POST', headers: { cookie: ben, 'content-type': 'application/json' }, body: '{}' });
    const frames = await waitFrames(s, 4);
    await sleep(300);
    assert.deepEqual(
      s.frames.map(({ seq: _s, ...f }) => f),
      [
        { type: 'message.outbound', contact, client_ref: 'rt_ref', text: 'hi', status: 'queued', author: 'grader' },
        { type: 'message.status', contact, client_ref: 'rt_ref', status: 'delivered' },
        { type: 'conversation.assigned', contact, assignee: 'u_ben' },
        { type: 'conversation.status', contact, status: 'closed' },
      ],
    );
    assert.ok(rising(frames));
  });
});

describe('GET /ws?after=: replay', () => {
  it('a client that reconnects with after=<last seq> gets exactly what it missed, then live', async () => {
    const first = await track(openSocket(A, 'workspace=ws_acme', { cookie: ben }));
    for (let i = 0; i < 3; i++) await webhook(A, inbound('ws_acme', '+14155550101'));
    const seen = await waitFrames(first, 3);
    const last = seen[seen.length - 1].seq!;
    first.ws.close();
    await sleep(200);

    const missed: string[] = [];
    for (let i = 0; i < 4; i++) {
      const ev = inbound('ws_acme', '+14155550102');
      missed.push(ev.data.message_id);
      await webhook(B, ev);
    }
    const again = await track(openSocket(B, `workspace=ws_acme&after=${last}`, { cookie: ben }));
    const replayed = await waitFrames(again, 4);
    assert.deepEqual(replayed.map((f) => f.message_id), missed);
    assert.ok(replayed.every((f) => f.seq! > last), 'nothing at or before after= is sent again');
    assert.ok(rising(replayed));

    await webhook(A, inbound('ws_acme', '+14155550103', 'pmsg_after_replay'));
    const all = await waitFrames(again, 5);
    assert.equal(all[4].message_id, 'pmsg_after_replay');
    assert.ok(rising(all));
  });

  it('without after=, a new socket starts at now (no history)', async () => {
    await webhook(A, inbound('ws_acme', '+14155550101', 'pmsg_old'));
    await sleep(200);
    const s = await track(openSocket(A, 'workspace=ws_acme', { cookie: ben }));
    await webhook(A, inbound('ws_acme', '+14155550101', 'pmsg_new'));
    const [f] = await waitFrames(s, 1);
    assert.equal(f.message_id, 'pmsg_new');
    await sleep(200);
    assert.equal(s.frames.filter((x) => x.seq !== undefined).length, 1);
  });

  it('after= ahead of the log (it was reset) gets a resync notice', async () => {
    const s = await track(openSocket(A, 'workspace=ws_acme&after=999999', { cookie: ben }));
    await sleep(200);
    assert.equal(s.frames[0]?.type, 'resync');
  });

  it('an open socket learns of a reset: resync, then closed with 4000', async () => {
    const s = await track(openSocket(A, 'workspace=ws_acme', { cookie: ben }));
    for (let i = 0; i < 3; i++) await webhook(A, inbound('ws_acme', '+14155550101'));
    await waitFrames(s, 3);
    await post(A, '/__grader/reset', {});
    await webhook(A, inbound('ws_acme', '+14155550101')); // seq 1 again
    assert.equal(await Promise.race([s.closed, sleep(4000).then(() => -1)]), 4000);
    assert.equal(s.frames[s.frames.length - 1].type, 'resync');
  });
});

describe('only newly stored inbound messages are announced', () => {
  it('stored but never announced (crash before publishing): the redelivery announces it, once', async () => {
    const s = await track(openSocket(A, 'workspace=ws_acme', { cookie: ben }));
    const ev = inbound('ws_acme', '+13035550106', 'pmsg_crashed');
    await (await messages()).insertOne({ workspace: 'ws_acme', contact: '+13035550106', direction: 'inbound', messageId: 'pmsg_crashed', text: ev.data.text, occurredAt: new Date(ev.occurred_at), createdAt: new Date(), emitted: false });
    await webhook(A, ev); // Pigeon retries because we never answered 2xx
    await webhook(B, ev); // and again
    await waitFrames(s, 1, 'message.inbound');
    await sleep(400);
    assert.equal(s.frames.filter((f) => f.message_id === 'pmsg_crashed').length, 1);
  });
});
