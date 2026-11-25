// Level 4: the written rules from PIGEON.md ("How your endpoint must answer")
// and the BRIEF.md grader contract, one describe() per rule, with the awkward
// variants of each. Real MongoDB/Redis (npm run up) and a fake Pigeon that
// counts sends.
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

// ---------------------------------------------------------------- fake Pigeon
const sends: { key: string | null; clientRef: string }[] = [];
const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
const fake: Server = createServer(async (req, res) => {
  const body = JSON.parse(await readBody(req));
  sends.push({ key: (req.headers['idempotency-key'] as string) ?? null, clientRef: body.client_ref });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: `pm_${body.client_ref}`, status: 'accepted' }));
});
await new Promise<void>((r) => fake.listen(0, r));

process.env.PIGEON_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
process.env.MONGO_URL = 'mongodb://localhost:27017/switchboard_test_level4';
process.env.REDIS_URL = 'redis://localhost:6379/12';
process.env.OUTBOX_POLL_MS = '50';

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
const token = config.graderToken;
const grader = { 'content-type': 'application/json', 'x-grader-token': token };
const now = () => Math.floor(Date.now() / 1000);
const sign = (raw: string, t = now(), secret = config.pigeon.webhookSecret) => `t=${t},v1=${computeSignature(secret, t, Buffer.from(raw)).toString('hex')}`;

async function webhook(raw: string, signature: string | null, contentType = 'application/json') {
  const headers: Record<string, string> = { 'content-type': contentType };
  if (signature !== null) headers['x-pigeon-signature'] = signature;
  return (await fetch(base + '/webhooks/pigeon', { method: 'POST', headers, body: raw })).status;
}
const signed = (raw: string, contentType?: string) => webhook(raw, sign(raw), contentType);

const inbound = (workspace: string, id: string, from = '+14155550101') =>
  JSON.stringify({ id: `evt_${id}`, type: 'message.inbound', workspace, occurred_at: new Date().toISOString(), data: { message_id: id, from, text: 'hi' } });
const status = (workspace: string, data: Record<string, unknown>) =>
  JSON.stringify({ id: 'evt_s', type: 'message.status', workspace, occurred_at: new Date().toISOString(), data });

const call = (method: string, path: string, body?: string, headers: Record<string, string> = grader) =>
  fetch(base + path, { method, headers, body }).then((r) => r.status);
const snapshot = async () => (await fetch(base + '/__grader/snapshot', { headers: grader })).json();
const reply = (b: Record<string, unknown>) => call('POST', '/__grader/reply', JSON.stringify(b));
const claim = (b: Record<string, unknown>) => call('POST', '/__grader/claim', JSON.stringify(b));

async function waitFor(fn: () => Promise<boolean>, ms = 5000) {
  const until = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

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
  assert.equal(await call('POST', '/__grader/reset'), 200);
  sends.length = 0;
});

// ---------------------------------------------------------------- rules
describe('rule: a missing, malformed or wrong signature is 401, never 5xx', () => {
  const raw = inbound('ws_acme', 'pmsg_sig');
  const good = sign(raw);
  const cases: [string, string | null][] = [
    ['no header', null],
    ['empty header', ''],
    ['garbage', 'garbage'],
    ['only t', `t=${now()}`],
    ['only v1', good.split(',')[1]],
    ['t not a number', good.replace(/^t=\d+/, 't=yesterday')],
    ['v1 too short', good.slice(0, -2)],
    ['v1 not hex', good.slice(0, -1) + 'z'],
    ['two t values', `t=1,${good}`],
    ['wrong secret', sign(raw, now(), 'not-the-secret')],
    ['signature of another body', sign(inbound('ws_acme', 'pmsg_other'))],
    ['timestamp changed after signing', good.replace(/^t=\d+/, `t=${now() + 1}`)],
    ['an hour old (replay)', sign(raw, now() - 3600)],
    ['10 minutes in the future', sign(raw, now() + 600)],
    ['a 10 kB header', 't=1,v1=' + 'a'.repeat(10_000)],
  ];
  for (const [name, header] of cases) {
    it(`401: ${name}`, async () => assert.equal(await webhook(raw, header), 401));
  }

  it('401 when both the signature and the body are bad (signature is checked first)', async () => {
    assert.equal(await webhook('{not json', 'garbage'), 401);
  });

  it('none of the rejected events was stored', async () => {
    for (const [, header] of cases) await webhook(raw, header);
    assert.deepEqual((await snapshot()).workspaces.ws_acme.contacts, {});
  });
});

describe('rule: a valid signature on a body we cannot parse is 400, never 5xx', () => {
  const bodies: [string, string][] = [
    ['not JSON', '{not json'],
    ['empty body', ''],
    ['JSON null', 'null'],
    ['JSON array', '[]'],
    ['JSON string', '"message.inbound"'],
    ['no type', '{"workspace":"ws_acme"}'],
    ['inbound without data', '{"type":"message.inbound","workspace":"ws_acme"}'],
    ['inbound with a non-string text', '{"type":"message.inbound","workspace":"ws_acme","occurred_at":"2026-11-18T09:30:00Z","data":{"message_id":"m","from":"+1","text":5}}'],
    ['inbound with a bad occurred_at', '{"type":"message.inbound","workspace":"ws_acme","occurred_at":"soon","data":{"message_id":"m","from":"+1","text":"x"}}'],
    ['status without data', '{"type":"message.status","workspace":"ws_acme"}'],
  ];
  for (const [name, raw] of bodies) {
    it(`400: ${name}`, async () => assert.equal(await signed(raw), 400));
  }

  it('the content-type header does not matter: the raw bytes are verified and parsed', async () => {
    assert.equal(await signed(inbound('ws_acme', 'pmsg_text_plain'), 'text/plain'), 200);
    assert.deepEqual((await snapshot()).workspaces.ws_acme.contacts['+14155550101'].inbound, ['pmsg_text_plain']);
  });
});

describe('rule: unknown event type, unknown workspace, status for a message never sent: 2xx and ignored', () => {
  it('2xx for an unknown event type, even with an unusual body', async () => {
    assert.equal(await signed('{"type":"contact.typing","workspace":"ws_acme","data":{}}'), 200);
    assert.equal(await signed('{"type":"billing.changed"}'), 200);
  });

  it('2xx for an inbound message to an unknown workspace, and nothing is stored', async () => {
    assert.equal(await signed(inbound('ws_initech', 'pmsg_initech')), 200);
    const snap = await snapshot();
    assert.equal(snap.workspaces.ws_initech, undefined);
    assert.deepEqual(snap.workspaces.ws_acme.contacts, {});
  });

  it('2xx for workspace names that exist on every object (toString, __proto__)', async () => {
    assert.equal(await signed(inbound('toString', 'pmsg_ts')), 200);
    assert.equal(await signed(inbound('__proto__', 'pmsg_proto')), 200);
  });

  it('2xx for a status in an unknown workspace', async () => {
    assert.equal(await signed(status('ws_initech', { message_id: 'pm_1', client_ref: 'r', status: 'delivered' })), 200);
  });

  it('2xx for a status of a message we never sent, by client_ref or by message_id only', async () => {
    assert.equal(await signed(status('ws_acme', { message_id: 'pm_x', client_ref: 'never', status: 'delivered' })), 200);
    assert.equal(await signed(status('ws_acme', { message_id: 'pm_only', status: 'sent' })), 200);
    assert.deepEqual((await snapshot()).workspaces.ws_acme.outbound, {});
  });

  it('2xx for a status value we do not know, and the reply keeps its status', async () => {
    assert.equal(await reply({ workspace: 'ws_acme', contact: '+1', text: 'x', client_ref: 'known' }), 202);
    assert.equal(await signed(status('ws_acme', { client_ref: 'known', status: 'read' })), 200);
    assert.equal((await snapshot()).workspaces.ws_acme.outbound.known, 'queued');
  });

  it("a status sent under another workspace does not touch this workspace's reply", async () => {
    assert.equal(await reply({ workspace: 'ws_acme', contact: '+1', text: 'x', client_ref: 'mine' }), 202);
    assert.equal(await signed(status('ws_globex', { client_ref: 'mine', status: 'failed' })), 200);
    assert.equal((await snapshot()).workspaces.ws_acme.outbound.mine, 'queued');
  });
});

describe('rule: grader endpoints answer 401 without the right x-grader-token', () => {
  const endpoints: [string, string, string?][] = [
    ['POST', '/__grader/reset'],
    ['GET', '/__grader/snapshot'],
    ['POST', '/__grader/reply', '{"workspace":"ws_acme","contact":"+1","text":"x","client_ref":"r"}'],
    ['POST', '/__grader/claim', '{"workspace":"ws_acme","contact":"+1","agent":"a"}'],
    ['GET', '/__grader/does-not-exist'],
  ];
  const tokens: [string, Record<string, string>][] = [
    ['missing', { 'content-type': 'application/json' }],
    ['empty', { 'content-type': 'application/json', 'x-grader-token': '' }],
    ['wrong', { 'content-type': 'application/json', 'x-grader-token': 'nope' }],
    ['wrong case', { 'content-type': 'application/json', 'x-grader-token': token.toUpperCase() }],
    ['a prefix of the token', { 'content-type': 'application/json', 'x-grader-token': token.slice(0, -1) }],
    ['the token plus more', { 'content-type': 'application/json', 'x-grader-token': token + 'x' }],
    ['the token in another header', { 'content-type': 'application/json', authorization: `Bearer ${token}` }],
  ];
  for (const [tokenName, headers] of tokens) {
    it(`401 when the token is ${tokenName}, on every endpoint`, async () => {
      for (const [method, path, body] of endpoints) assert.equal(await call(method, path, body, headers), 401, `${method} ${path}`);
    });
  }

  it('401 (not 400) for a malformed body without the token', async () => {
    assert.equal(await call('POST', '/__grader/reply', '{not json', { 'content-type': 'application/json' }), 401);
  });

  it('nothing happens on a refused call: no reply stored, no claim made', async () => {
    const bad = { 'content-type': 'application/json', 'x-grader-token': 'nope' };
    await call('POST', '/__grader/reply', endpoints[2][2], bad);
    await call('POST', '/__grader/claim', endpoints[3][2], bad);
    assert.deepEqual((await snapshot()).workspaces.ws_acme, { contacts: {}, outbound: {} });
  });
});

describe('rule: a reply to a workspace that does not exist is 4xx', () => {
  for (const workspace of ['ws_initech', 'WS_ACME', 'toString', '__proto__', 'constructor', '']) {
    it(`4xx for ${JSON.stringify(workspace)}, and nothing is stored`, async () => {
      const s = await reply({ workspace, contact: '+1', text: 'x', client_ref: `r_${workspace}` });
      assert.ok(s >= 400 && s < 500, `got ${s}`);
      const snap = await snapshot();
      assert.deepEqual(Object.keys(snap.workspaces).sort(), ['ws_acme', 'ws_globex']);
      assert.deepEqual(snap.workspaces.ws_acme.outbound, {});
    });
  }

  it('4xx for a workspace that is not a string', async () => {
    assert.equal(await reply({ workspace: 42, contact: '+1', text: 'x', client_ref: 'r' }), 400);
  });
});

describe('rule: the same client_ref asked twice at once is one reply: both 202, one send', () => {
  it('two simultaneous requests: both 202, Pigeon receives exactly one send', async () => {
    const body = { workspace: 'ws_acme', contact: '+14155550101', text: 'once', client_ref: 'twice_at_once' };
    const w = new OutboxWorker({ log: () => {} });
    w.start();
    try {
      assert.deepEqual(await Promise.all([reply(body), reply(body)]), [202, 202]);
      await waitFor(async () => (await (await messages()).findOne({ clientRef: 'twice_at_once' }))?.sendState === 'accepted');
      await new Promise((r) => setTimeout(r, 300)); // room for a second send, if there were one
      assert.deepEqual(sends, [{ key: 'twice_at_once', clientRef: 'twice_at_once' }]);
      assert.equal(await (await messages()).countDocuments({ clientRef: 'twice_at_once' }), 1);
    } finally {
      await w.stop();
    }
  });

  it('asked again after it was sent: 202, and not sent again', async () => {
    const body = { workspace: 'ws_acme', contact: '+14155550102', text: 'once', client_ref: 'again_later' };
    const w = new OutboxWorker({ log: () => {} });
    w.start();
    try {
      assert.equal(await reply(body), 202);
      await waitFor(async () => sends.length === 1);
      assert.equal(await reply(body), 202);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(sends.length, 1);
    } finally {
      await w.stop();
    }
  });

  it('the same client_ref in two workspaces is two replies', async () => {
    assert.equal(await reply({ workspace: 'ws_acme', contact: '+1', text: 'x', client_ref: 'shared' }), 202);
    assert.equal(await reply({ workspace: 'ws_globex', contact: '+2', text: 'x', client_ref: 'shared' }), 202);
    const snap = await snapshot();
    assert.equal(snap.workspaces.ws_acme.outbound.shared, 'queued');
    assert.equal(snap.workspaces.ws_globex.outbound.shared, 'queued');
  });
});

describe('rule: the holder claiming again gets 200', () => {
  const c = { workspace: 'ws_globex', contact: '+442079460201' };

  it('200, 200 for the holder; 409 for anyone else; the holder stays the assignee', async () => {
    assert.equal(await claim({ ...c, agent: 'u_dev' }), 200);
    assert.equal(await claim({ ...c, agent: 'u_dev' }), 200);
    assert.equal(await claim({ ...c, agent: 'u_chloe' }), 409);
    assert.equal(await claim({ ...c, agent: 'u_dev' }), 200);
    assert.equal((await snapshot()).workspaces.ws_globex.contacts[c.contact].assignee, 'u_dev');
  });

  it('the same agent claiming twice at the same instant gets 200 both times', async () => {
    assert.deepEqual(await Promise.all([claim({ ...c, agent: 'u_dev' }), claim({ ...c, agent: 'u_dev' })]), [200, 200]);
  });

  it('the holder racing five others while already holding it: holder 200, others 409', async () => {
    assert.equal(await claim({ ...c, agent: 'u_dev' }), 200);
    const agents = ['u_dev', 'a1', 'a2', 'a3', 'a4', 'a5'];
    const statuses = await Promise.all(agents.map((agent) => claim({ ...c, agent })));
    assert.deepEqual(statuses, [200, 409, 409, 409, 409, 409]);
  });

  it('the claim creates the conversation when the contact has never written', async () => {
    assert.equal(await claim({ workspace: 'ws_acme', contact: '+19995550000', agent: 'u_ben' }), 200);
    assert.deepEqual((await snapshot()).workspaces.ws_acme.contacts['+19995550000'], { inbound: [], assignee: 'u_ben' });
  });
});
