// The bonus grader's scenario (BONUS_BILLING.md, "What the grader does")
// against a running server that receives Paybox's real webhooks on :4000.
// Skipped unless BILLING_E2E_URL is set:
//   PORT=4000 npm --prefix scaffold/server start      (in one terminal)
//   cd scaffold/server && BILLING_E2E_URL=http://localhost:4000 npx tsx --test ../../tests/billing.e2e.test.ts
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

const APP = process.env.BILLING_E2E_URL;
const { config } = await import('../scaffold/server/src/config.js');
const { closeDb, getDb } = await import('../scaffold/server/src/db.js');

const PAYBOX = config.paybox.url;
const PIGEON = config.pigeon.url;
const grader = { 'content-type': 'application/json', 'x-grader-token': config.graderToken };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (url: string, body: object, headers: Record<string, string> = { 'content-type': 'application/json' }) => fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
const json = async (url: string) => (await fetch(url, { headers: grader })).json();

async function token(number: string): Promise<string> {
  const res = await post(`${PAYBOX}/v1/tokens`, { card: { number, exp_month: 12, exp_year: 2030, cvc: '123' } }, { 'content-type': 'application/json', authorization: `Bearer ${config.paybox.publishableKey}` });
  return (await res.json()).id;
}
/** Billing as stored by the server from webhooks alone (the snapshot would re-read Paybox). */
const stored = async (workspace: string) => (await getDb()).collection('billing').findOne({ workspace });

after(() => closeDb());

describe('billing end to end, with real Paybox webhooks', { skip: !APP && 'set BILLING_E2E_URL to run' }, () => {
  it("runs the bonus grader's scenario", async () => {
    assert.equal((await post(`${APP}/__grader/reset`, {}, grader)).status, 200);
    assert.equal((await post(`${PAYBOX}/__admin/reset`, {})).status, 200);

    // 1. Subscribe a workspace three times in the same instant.
    const tokens = await Promise.all([1, 2, 3].map(() => token('4242424242424242')));
    const three = await Promise.all(tokens.map((t) => post(`${APP}/__grader/billing/subscribe`, { workspace: 'ws_acme', seats: 3, token: t }, grader).then((r) => r.status)));
    assert.deepEqual(three, [200, 200, 200]);

    // 2. Change seats.
    assert.equal((await post(`${APP}/__grader/billing/seats`, { workspace: 'ws_acme', seats: 5 }, grader)).status, 200);

    // 3. Pay for a second workspace with a card that only works once, then move past the renewal and the retries.
    assert.equal((await post(`${APP}/__grader/billing/subscribe`, { workspace: 'ws_globex', seats: 2, token: await token('4000000000000341') }, grader)).status, 200);
    await post(`${PAYBOX}/v1/test_clock/advance`, { days: 31 });
    await sleep(4000); // webhooks: up to 0.8 s delay, plus retries
    assert.equal((await stored('ws_globex'))?.status, 'past_due', 'learned from webhooks alone');
    await post(`${PAYBOX}/v1/test_clock/advance`, { days: 6 });
    await sleep(4000);
    assert.equal((await stored('ws_globex'))?.status, 'canceled', 'learned from webhooks alone');

    // 4. A forged webhook.
    const forged = await (await post(`${PAYBOX}/__admin/forge`, { workspace: 'ws_globex' })).json();
    assert.equal(forged.delivered, 401);

    // 5. The canceled workspace cannot send; the paying one still can.
    const snap = await json(`${APP}/__grader/snapshot`);
    assert.deepEqual(snap.workspaces.ws_globex.billing, { status: 'canceled', seats: 2, can_send: false });
    assert.deepEqual(snap.workspaces.ws_acme.billing, { status: 'active', seats: 5, can_send: true });
    const ref = `e2e_${Date.now()}`;
    assert.equal((await post(`${APP}/__grader/reply`, { workspace: 'ws_globex', contact: '+442079460201', text: 'blocked', client_ref: `${ref}_globex` }, grader)).status, 402);
    assert.equal((await post(`${APP}/__grader/reply`, { workspace: 'ws_acme', contact: '+14155550101', text: 'allowed', client_ref: `${ref}_acme` }, grader)).status, 202);
    await sleep(6000);
    const pigeon = await (await fetch(`${PIGEON}/__admin/report`)).json();
    assert.ok(!(`${ref}_globex` in pigeon.sends.finalStatusByClientRef), 'the canceled workspace sent nothing');
    assert.ok(`${ref}_acme` in pigeon.sends.finalStatusByClientRef, 'the paying workspace sent');

    // 6. Paybox's own record of how we called it.
    const r = await (await fetch(`${PAYBOX}/__admin/report`)).json();
    for (const ws of ['ws_acme', 'ws_globex']) assert.equal(r.customers.filter((c: { workspace: string }) => c.workspace === ws).length, 1, `one customer for ${ws}`);
    assert.equal(r.customers.find((c: { workspace: string }) => c.workspace === 'ws_acme').subscriptions.length, 1);
    assert.deepEqual(r.flags, { rawCardViaSecretKey: 0, postsWithoutIdempotencyKey: 0 });
    assert.equal(r.webhooks.forgedAccepted, 0);
    assert.ok(r.webhooks.sent > 0 && r.webhooks.acked === r.webhooks.sent, `webhooks acked ${r.webhooks.acked} of ${r.webhooks.sent}`);
    console.log('paybox report:', JSON.stringify({ flags: r.flags, webhooks: r.webhooks }));
  });
});
