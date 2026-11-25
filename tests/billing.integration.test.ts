// Bonus billing against the real Paybox simulator (npm run up), MongoDB and
// Redis. Follows "What the grader does" in BONUS_BILLING.md. Paybox's own
// webhooks go to :4000, not to this test server, so webhook handling is
// tested with events we sign ourselves; the state still follows Paybox
// because the snapshot and the reply gate read it.
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

process.env.MONGO_URL = 'mongodb://localhost:27017/switchboard_test_billing';
process.env.REDIS_URL = 'redis://localhost:6379/9';

const { config } = await import('../scaffold/server/src/config.js');
const { createApp } = await import('../scaffold/server/src/app.js');
const { initialise } = await import('../scaffold/server/src/health.js');
const { closeDb, getDb } = await import('../scaffold/server/src/db.js');
const { closeRedis } = await import('../scaffold/server/src/redis.js');
const { computeSignature } = await import('../scaffold/server/src/webhooks/signature.js');

const PAYBOX = config.paybox.url;
const CARDS = { ok: '4242424242424242', declined: '4000000000000002', once: '4000000000000341', auth: '4000002500003155' };
let app: Server;
let base: string;
const grader = { 'content-type': 'application/json', 'x-grader-token': config.graderToken };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- helpers
const post = (path: string, body: object, headers = grader) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
const snapshot = async () => (await fetch(base + '/__grader/snapshot', { headers: grader })).json();
const billingOf = async (ws: string) => (await snapshot()).workspaces[ws].billing;
const report = async () => (await fetch(PAYBOX + '/__admin/report')).json();
const advance = (days: number) => fetch(PAYBOX + '/v1/test_clock/advance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ days }) });

/** What the browser does with the publishable key; the number never reaches our server. */
async function token(number: string): Promise<string> {
  const res = await fetch(PAYBOX + '/v1/tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.paybox.publishableKey}` },
    body: JSON.stringify({ card: { number, exp_month: 12, exp_year: 2030, cvc: '123' } }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).id;
}
const subscribe = async (workspace: string, seats: number, number = CARDS.ok) => post('/__grader/billing/subscribe', { workspace, seats, token: await token(number) });
const seats = (workspace: string, n: number) => post('/__grader/billing/seats', { workspace, seats: n });
const reply = (workspace: string, client_ref: string) => post('/__grader/reply', { workspace, contact: workspace === 'ws_acme' ? '+14155550101' : '+442079460201', text: 'hi', client_ref });
const customersOf = async (ws: string) => (await report()).customers.filter((c: { workspace: string }) => c.workspace === ws);

function signedPaybox(event: object, secret = config.paybox.webhookSecret) {
  const raw = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  return fetch(base + '/webhooks/paybox', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-paybox-signature': `t=${t},v1=${computeSignature(secret, t, Buffer.from(raw)).toString('hex')}` },
    body: raw,
  });
}

before(async () => {
  await initialise();
  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});

after(async () => {
  app.close();
  await closeDb();
  await closeRedis();
});

beforeEach(async () => {
  assert.equal((await post('/__grader/reset', {})).status, 200);
  assert.equal((await fetch(PAYBOX + '/__admin/reset', { method: 'POST' })).status, 200);
});

// ---------------------------------------------------------------- tests
describe('billing: trial', () => {
  it('a workspace that never subscribed is on the trial and can send', async () => {
    assert.deepEqual(await billingOf('ws_acme'), { status: 'none', seats: 0, can_send: true });
    assert.equal((await reply('ws_acme', 'trial_1')).status, 202);
  });
});

describe('billing: subscribe', () => {
  it('three subscribes in the same instant: all 200, one customer, one subscription, every POST idempotent', async () => {
    const tokens = await Promise.all([token(CARDS.ok), token(CARDS.ok), token(CARDS.ok)]);
    const statuses = await Promise.all(tokens.map((t) => post('/__grader/billing/subscribe', { workspace: 'ws_acme', seats: 3, token: t }).then((r) => r.status)));
    assert.deepEqual(statuses, [200, 200, 200]);
    const customers = await customersOf('ws_acme');
    assert.equal(customers.length, 1, 'one Paybox customer for the workspace');
    assert.equal(customers[0].subscriptions.length, 1, 'one subscription');
    assert.equal(customers[0].subscriptions[0].status, 'active');
    assert.equal(customers[0].subscriptions[0].quantity, 3);
    assert.deepEqual((await report()).flags, { rawCardViaSecretKey: 0, postsWithoutIdempotencyKey: 0 });
    assert.deepEqual(await billingOf('ws_acme'), { status: 'active', seats: 3, can_send: true });
  });

  it('the same token three times at once is also one subscription', async () => {
    const t = await token(CARDS.ok);
    const statuses = await Promise.all([1, 2, 3].map(() => post('/__grader/billing/subscribe', { workspace: 'ws_acme', seats: 2, token: t }).then((r) => r.status)));
    assert.deepEqual(statuses, [200, 200, 200]);
    assert.equal((await customersOf('ws_acme'))[0].subscriptions.length, 1);
  });

  it('a declined card is 402 and stays on the trial; a good card afterwards activates, with one live subscription', async () => {
    const bad = await subscribe('ws_acme', 2, CARDS.declined);
    assert.equal(bad.status, 402);
    assert.equal((await bad.json()).status, 'incomplete');
    assert.deepEqual(await billingOf('ws_acme'), { status: 'incomplete', seats: 2, can_send: true });
    assert.equal((await subscribe('ws_acme', 2)).status, 200);
    const subs = (await customersOf('ws_acme'))[0].subscriptions;
    assert.deepEqual(subs.map((s: { status: string }) => s.status).sort(), ['active', 'canceled']);
  });

  it('a card that needs the bank: 402 with where to send the browser; active once approved', async () => {
    const res = await subscribe('ws_acme', 1, CARDS.auth);
    assert.equal(res.status, 402);
    const body = await res.json();
    assert.equal(body.payment.status, 'requires_action');
    assert.match(body.payment.next_action_url, /\/authenticate\//);
    assert.match(body.message, /bank/);
    await fetch(body.payment.next_action_url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"outcome":"approve"}' });
    assert.equal((await billingOf('ws_acme')).status, 'active');
  });

  it('4xx for bad input: unknown workspace, bad seats, no token, no grader token', async () => {
    assert.equal((await post('/__grader/billing/subscribe', { workspace: 'ws_nope', seats: 1, token: 'tok_x' })).status, 404);
    assert.equal((await post('/__grader/billing/subscribe', { workspace: 'ws_acme', seats: 0, token: 'tok_x' })).status, 400);
    assert.equal((await post('/__grader/billing/subscribe', { workspace: 'ws_acme', seats: 1.5, token: 'tok_x' })).status, 400);
    assert.equal((await post('/__grader/billing/subscribe', { workspace: 'ws_acme', seats: 1 })).status, 400);
    assert.equal((await post('/__grader/billing/subscribe', { workspace: 'ws_acme', seats: 1, token: 'tok_x' }, { 'content-type': 'application/json' } as typeof grader)).status, 401);
  });
});

describe('billing: seats', () => {
  it('increases are charged and applied, decreases applied, and a repeat of an earlier change is a new change', async () => {
    assert.equal((await subscribe('ws_acme', 3)).status, 200);
    for (const n of [5, 2, 5]) {
      assert.equal((await seats('ws_acme', n)).status, 200, `to ${n}`);
      assert.equal((await billingOf('ws_acme')).seats, n);
    }
    assert.equal((await customersOf('ws_acme'))[0].subscriptions[0].quantity, 5);
    assert.equal((await seats('ws_acme', 5)).status, 200, 'no change is fine');
    assert.deepEqual((await report()).flags, { rawCardViaSecretKey: 0, postsWithoutIdempotencyKey: 0 });
  });

  it('an increase whose charge fails is 402 and the seats do not change', async () => {
    assert.equal((await subscribe('ws_globex', 2, CARDS.once)).status, 200);
    assert.equal((await seats('ws_globex', 4)).status, 402);
    assert.equal((await billingOf('ws_globex')).seats, 2);
    assert.equal((await customersOf('ws_globex'))[0].subscriptions[0].quantity, 2);
  });

  it('402 without an active subscription', async () => {
    assert.equal((await seats('ws_acme', 3)).status, 402);
  });
});

describe('billing: changes nobody clicked', () => {
  it('card that works once: past_due after the renewal, canceled after the retries; canceled cannot send, the paying workspace still can', async () => {
    assert.equal((await subscribe('ws_acme', 2, CARDS.ok)).status, 200);
    assert.equal((await subscribe('ws_globex', 2, CARDS.once)).status, 200);

    await advance(31); // renewal: globex's card is declined
    assert.deepEqual(await billingOf('ws_globex'), { status: 'past_due', seats: 2, can_send: true });
    assert.equal((await reply('ws_globex', 'grace_1')).status, 202, 'past_due is a grace period');

    await advance(6); // retries on day 3 and day 5 fail: Paybox cancels
    assert.deepEqual(await billingOf('ws_globex'), { status: 'canceled', seats: 2, can_send: false });
    assert.deepEqual(await billingOf('ws_acme'), { status: 'active', seats: 2, can_send: true });

    const refused = await reply('ws_globex', 'after_cancel');
    assert.equal(refused.status, 402);
    const snap = await snapshot();
    assert.equal(snap.workspaces.ws_globex.outbound.after_cancel, undefined, 'nothing stored, so nothing is sent');
    assert.equal((await reply('ws_acme', 'still_paying')).status, 202);
  });

  it('a signed webhook makes the server re-read the subscription from Paybox, whatever the event says', async () => {
    assert.equal((await subscribe('ws_globex', 1, CARDS.once)).status, 200);
    const sub = (await customersOf('ws_globex'))[0].subscriptions[0];
    await advance(31);
    // The event's object claims "active"; the present state at Paybox is past_due.
    const res = await signedPaybox({ id: 'evt_1', type: 'invoice.payment_failed', created: 0, data: { object: { id: 'in_1', subscription: sub.id, status: 'paid' } } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).result, 'applied');
    const stored = await (await getDb()).collection('billing').findOne({ workspace: 'ws_globex' });
    assert.equal(stored?.status, 'past_due');
  });

  it('a forged webhook claiming payment is 401 and changes nothing', async () => {
    assert.equal((await subscribe('ws_globex', 1, CARDS.once)).status, 200);
    const sub = (await customersOf('ws_globex'))[0].subscriptions[0];
    await advance(37);
    const forged = await signedPaybox({ id: 'evt_f', type: 'customer.subscription.updated', created: 0, data: { object: { id: sub.id, status: 'active' } } }, 'not-the-secret');
    assert.equal(forged.status, 401);
    const unsigned = await fetch(base + '/webhooks/paybox', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(unsigned.status, 401);
    assert.equal((await billingOf('ws_globex')).status, 'canceled');
  });

  it('signed but useless webhooks: unparseable 400, unknown type or subscription 200 and ignored', async () => {
    const raw = '{not json';
    const t = Math.floor(Date.now() / 1000);
    const bad = await fetch(base + '/webhooks/paybox', { method: 'POST', headers: { 'x-paybox-signature': `t=${t},v1=${computeSignature(config.paybox.webhookSecret, t, Buffer.from(raw)).toString('hex')}` }, body: raw });
    assert.equal(bad.status, 400);
    assert.equal((await (await signedPaybox({ id: 'e', type: 'charge.refunded', data: { object: {} } })).json()).result, 'ignored');
    assert.equal((await (await signedPaybox({ id: 'e', type: 'customer.subscription.updated', data: { object: { id: 'sub_unknown' } } })).json()).result, 'ignored');
  });
});

describe('billing: the admin API', () => {
  async function signIn(sub: string): Promise<string> {
    const start = await fetch(base + '/auth/login', { redirect: 'manual' });
    const login = start.headers.getSetCookie()[0].split(';')[0];
    const idp = await fetch(start.headers.get('location') + '&login=' + sub, { redirect: 'manual' });
    const back = new URL(idp.headers.get('location')!);
    const done = await fetch(base + back.pathname + back.search, { redirect: 'manual', headers: { cookie: login } });
    return done.headers.getSetCookie().find((c) => c.startsWith('sb_session='))!.split(';')[0];
  }

  it('admins see the state in plain words and can subscribe and change seats; agents get 403', async () => {
    const asha = await signIn('u_asha'); // ws_acme admin
    const ben = await signIn('u_ben'); // ws_acme agent
    const get = (cookie: string) => fetch(base + '/api/billing?workspace=ws_acme', { headers: { cookie } });

    assert.equal((await get(ben)).status, 403);
    const trial = await (await get(asha)).json();
    assert.equal(trial.status, 'none');
    assert.match(trial.message, /Free trial/);
    assert.deepEqual(trial.paybox, { url: config.paybox.url, publishable_key: config.paybox.publishableKey });
    assert.ok(!JSON.stringify(trial).includes(config.paybox.secretKey), 'the secret key never leaves the server');

    const sub = await fetch(base + '/api/billing/subscribe?workspace=ws_acme', { method: 'POST', headers: { cookie: asha, 'content-type': 'application/json' }, body: JSON.stringify({ seats: 4, token: await token(CARDS.ok) }) });
    assert.equal(sub.status, 200);
    assert.match((await sub.json()).message, /Active: 4 seats/);
    const more = await fetch(base + '/api/billing/seats?workspace=ws_acme', { method: 'POST', headers: { cookie: asha, 'content-type': 'application/json' }, body: JSON.stringify({ seats: 6 }) });
    assert.equal(more.status, 200);
    assert.equal((await fetch(base + '/api/billing/seats?workspace=ws_acme', { method: 'POST', headers: { cookie: ben, 'content-type': 'application/json' }, body: JSON.stringify({ seats: 1 }) })).status, 403);
    assert.equal((await fetch(base + '/api/billing?workspace=ws_globex', { headers: { cookie: asha } })).status, 403);
  });

  it('a canceled workspace still reads its inbox', async () => {
    assert.equal((await subscribe('ws_globex', 1, CARDS.once)).status, 200);
    await advance(37);
    await sleep(50);
    const chloe = await signIn('u_chloe');
    assert.equal((await fetch(base + '/api/conversations?workspace=ws_globex', { headers: { cookie: chloe } })).status, 200);
  });
});
