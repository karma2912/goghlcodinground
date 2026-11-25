// Login through the real mock IdP (npm run up) and the agent API, with real
// MongoDB and Redis. Signs in the way level 5 of the check does.
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

process.env.MONGO_URL = 'mongodb://localhost:27017/switchboard_test_api';
process.env.REDIS_URL = 'redis://localhost:6379/11';

const { config } = await import('../scaffold/server/src/config.js');
const { createApp } = await import('../scaffold/server/src/app.js');
const { initialise } = await import('../scaffold/server/src/health.js');
const { closeDb } = await import('../scaffold/server/src/db.js');
const { closeRedis, getRedis, SESSION_PREFIX } = await import('../scaffold/server/src/redis.js');
const { recordInbound } = await import('../scaffold/server/src/services/inbound.js');

let app: Server;
let base: string;
const grader = { 'content-type': 'application/json', 'x-grader-token': config.graderToken };

// ---------------------------------------------------------------- a browser
class Browser {
  jar = new Map<string, string>();
  cookie = () => [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  keep(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      if (attrs.some((a) => /max-age=0/i.test(a.trim()))) this.jar.delete(name);
      else this.jar.set(name, pair.slice(i + 1));
    }
  }
  async get(path: string) {
    const res = await fetch(base + path, { redirect: 'manual', headers: { cookie: this.cookie() } });
    this.keep(res);
    return res;
  }
  async send(method: string, path: string, body?: unknown, contentType = 'application/json') {
    const res = await fetch(base + path, { method, redirect: 'manual', headers: { cookie: this.cookie(), 'content-type': contentType }, body: body === undefined ? undefined : JSON.stringify(body) });
    this.keep(res);
    return res;
  }
  async json(path: string) {
    return (await this.get(path)).json();
  }
}

/** Start at /auth/login, pick the user at the IdP, follow back to our callback. Returns the callback response. */
async function signIn(b: Browser, sub: string): Promise<Response> {
  const start = await b.get('/auth/login');
  assert.equal(start.status, 302);
  const idp = await fetch(start.headers.get('location') + '&login=' + sub, { redirect: 'manual' });
  const back = new URL(idp.headers.get('location')!);
  return b.get(back.pathname + back.search);
}

async function signedIn(sub: string): Promise<Browser> {
  const b = new Browser();
  const res = await signIn(b, sub);
  assert.equal(res.status, 302, await res.clone().text());
  return b;
}

const reply = (workspace: string, contact: string, client_ref: string) =>
  fetch(base + '/__grader/reply', { method: 'POST', headers: grader, body: JSON.stringify({ workspace, contact, text: `reply ${client_ref}`, client_ref }) });

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
  assert.equal((await fetch(base + '/__grader/reset', { method: 'POST', headers: grader })).status, 200);
});

// ---------------------------------------------------------------- login
describe('GET /auth/login', () => {
  it('redirects to the IdP with code flow, PKCE S256, state, nonce and our redirect_uri', async () => {
    const b = new Browser();
    const res = await b.get('/auth/login');
    assert.equal(res.status, 302);
    const url = new URL(res.headers.get('location')!);
    assert.equal(url.origin + url.pathname, `${config.oidc.issuer}/authorize`);
    const q = url.searchParams;
    assert.equal(q.get('response_type'), 'code');
    assert.equal(q.get('client_id'), config.oidc.clientId);
    assert.equal(q.get('redirect_uri'), config.oidc.redirectUri);
    assert.equal(q.get('code_challenge_method'), 'S256');
    assert.match(q.get('code_challenge')!, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(q.get('state') && q.get('nonce') && q.get('state') !== q.get('nonce'));
    assert.equal(b.jar.get('sb_login'), q.get('state'), 'the login is bound to this browser');
    assert.match(res.headers.getSetCookie()[0], /HttpOnly; SameSite=Lax/);
  });

  it('every login gets a fresh state', async () => {
    const one = new URL((await new Browser().get('/auth/login')).headers.get('location')!).searchParams.get('state');
    const two = new URL((await new Browser().get('/auth/login')).headers.get('location')!).searchParams.get('state');
    assert.notEqual(one, two);
  });
});

describe('GET /auth/callback', () => {
  it('signs in, sets an HttpOnly session cookie and sends the browser to the web app', async () => {
    const b = new Browser();
    const res = await signIn(b, 'u_ben');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), new URL('/', config.webOrigin).toString());
    const session = res.headers.getSetCookie().find((c) => c.startsWith('sb_session='));
    assert.match(session!, /HttpOnly; SameSite=Lax/);
    assert.ok(b.jar.has('sb_session') && !b.jar.has('sb_login'));
  });

  it('refuses a callback replayed after it was used (state is single use)', async () => {
    const b = new Browser();
    const start = await b.get('/auth/login');
    const idp = await fetch(start.headers.get('location') + '&login=u_ben', { redirect: 'manual' });
    const back = new URL(idp.headers.get('location')!);
    const loginCookie = b.jar.get('sb_login')!;
    assert.equal((await b.get(back.pathname + back.search)).status, 302);
    b.jar.set('sb_login', loginCookie); // an attacker replays everything
    assert.equal((await b.get(back.pathname + back.search)).status, 400);
  });

  it('refuses a callback in a browser that did not start the login (login CSRF)', async () => {
    const attacker = new Browser();
    const start = await attacker.get('/auth/login');
    const idp = await fetch(start.headers.get('location') + '&login=u_asha', { redirect: 'manual' });
    const back = new URL(idp.headers.get('location')!);
    const victim = new Browser();
    const res = await victim.get(back.pathname + back.search);
    assert.equal(res.status, 400);
    assert.ok(!victim.jar.has('sb_session'));
  });

  it('refuses a made-up state, a missing code, and an IdP error', async () => {
    const b = new Browser();
    await b.get('/auth/login');
    assert.equal((await b.get(`/auth/callback?code=abc&state=${b.jar.get('sb_login')}x`)).status, 400);
    assert.equal((await b.get(`/auth/callback?state=${b.jar.get('sb_login')}`)).status, 400);
    assert.equal((await b.get('/auth/callback?error=access_denied')).status, 400);
  });
});

// ---------------------------------------------------------------- sessions
describe('GET /api/me', () => {
  it('answers who is signed in, with workspaces and roles from the IdP', async () => {
    const b = await signedIn('u_ben');
    assert.deepEqual(await b.json('/api/me'), { sub: 'u_ben', name: 'Ben Ortiz', email: 'ben@acme.test', workspaces: [{ id: 'ws_acme', role: 'agent' }] });
    const eli = await signedIn('u_eli');
    assert.deepEqual((await eli.json('/api/me')).workspaces, [{ id: 'ws_acme', role: 'agent' }, { id: 'ws_globex', role: 'agent' }]);
  });

  it('401 without a session, with a made-up session, and after logout', async () => {
    assert.equal((await new Browser().get('/api/me')).status, 401);
    const fake = new Browser();
    fake.jar.set('sb_session', 'A'.repeat(43));
    assert.equal((await fake.get('/api/me')).status, 401);
    const b = await signedIn('u_ben');
    const stolen = b.jar.get('sb_session')!;
    assert.equal((await b.send('POST', '/auth/logout')).status, 204);
    assert.equal((await b.get('/api/me')).status, 401);
    b.jar.set('sb_session', stolen); // the old cookie is dead on the server too
    assert.equal((await b.get('/api/me')).status, 401);
  });

  it('a session survives POST /__grader/reset', async () => {
    const b = await signedIn('u_ben');
    await fetch(base + '/__grader/reset', { method: 'POST', headers: grader });
    assert.equal((await b.get('/api/me')).status, 200);
  });

  it('Redis holds a hash of the session id, never the id itself', async () => {
    const b = await signedIn('u_ben');
    const id = b.jar.get('sb_session')!;
    const keys = await getRedis().keys(`${SESSION_PREFIX}*`);
    assert.ok(keys.length > 0);
    assert.ok(keys.every((k) => !k.includes(id)));
  });
});

// ---------------------------------------------------------------- tenant isolation
describe('GET /api/conversations: tenant isolation', () => {
  it('200 for your own workspace, 403 for another, 401 without a session, 400 without one named', async () => {
    const ben = await signedIn('u_ben');
    assert.equal((await ben.get('/api/conversations?workspace=ws_acme')).status, 200);
    assert.equal((await ben.get('/api/conversations?workspace=ws_globex')).status, 403);
    assert.equal((await ben.get('/api/conversations?workspace=ws_initech')).status, 403);
    assert.equal((await ben.get('/api/conversations')).status, 400);
    assert.equal((await new Browser().get('/api/conversations?workspace=ws_acme')).status, 401);
  });

  it("another workspace's conversation cannot be read, replied to, claimed or closed", async () => {
    await reply('ws_globex', '+442079460201', 'g1');
    const ben = await signedIn('u_ben');
    const c = encodeURIComponent('+442079460201');
    assert.equal((await ben.get(`/api/conversations/${c}?workspace=ws_globex`)).status, 403);
    assert.equal((await ben.send('POST', `/api/conversations/${c}/reply?workspace=ws_globex`, { text: 'x', client_ref: 'evil' })).status, 403);
    assert.equal((await ben.send('POST', `/api/conversations/${c}/claim?workspace=ws_globex`, {})).status, 403);
    assert.equal((await ben.send('POST', `/api/conversations/${c}/close?workspace=ws_globex`, {})).status, 403);
    // and naming his own workspace does not reach globex's data
    assert.equal((await ben.get(`/api/conversations/${c}?workspace=ws_acme`)).status, 404);
  });

  it('Eli, in both workspaces, sees each one separately', async () => {
    await reply('ws_acme', '+14155550101', 'a1');
    await reply('ws_globex', '+442079460201', 'g1');
    const eli = await signedIn('u_eli');
    const acme = await eli.json('/api/conversations?workspace=ws_acme');
    const globex = await eli.json('/api/conversations?workspace=ws_globex');
    assert.deepEqual(acme.conversations.map((c: { contact: string }) => c.contact), ['+14155550101']);
    assert.deepEqual(globex.conversations.map((c: { contact: string }) => c.contact), ['+442079460201']);
  });
});

// ---------------------------------------------------------------- the inbox
describe('the inbox API', () => {
  it('lists newest activity first and pages without repeats or gaps', async () => {
    const contacts = ['+10000000001', '+10000000002', '+10000000003', '+10000000004', '+10000000005'];
    for (const [i, c] of contacts.entries()) {
      await recordInbound({ workspace: 'ws_acme', contact: c, messageId: `pmsg_${i}`, text: 'hi', occurredAt: new Date(Date.UTC(2026, 10, 25, 12, 0, i)), eventId: null });
    }
    const b = await signedIn('u_ben');
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { conversations: { contact: string }[]; nextCursor: string | null } = await b.json(`/api/conversations?workspace=ws_acme&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...page.conversations.map((c) => c.contact));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    assert.equal(pages, 3);
    assert.deepEqual(seen, [...contacts].reverse());
    assert.equal((await b.get('/api/conversations?workspace=ws_acme&cursor=garbage')).status, 400);
  });

  it('shows a conversation with inbound and outbound messages in time order, matching the snapshot', async () => {
    const contact = '+14155550101';
    const t = Date.UTC(2026, 10, 25, 12, 0, 0);
    await recordInbound({ workspace: 'ws_acme', contact, messageId: 'pmsg_b', text: 'second', occurredAt: new Date(t + 2000), eventId: null });
    await recordInbound({ workspace: 'ws_acme', contact, messageId: 'pmsg_a', text: 'first', occurredAt: new Date(t), eventId: null });
    const ben = await signedIn('u_ben');
    const res = await ben.send('POST', `/api/conversations/${encodeURIComponent(contact)}/reply?workspace=ws_acme`, { text: 'hello from Ben', client_ref: 'ui_1' });
    assert.equal(res.status, 202);
    const conv = await ben.json(`/api/conversations/${encodeURIComponent(contact)}?workspace=ws_acme`);
    assert.deepEqual(conv.messages.map((m: { id: string }) => m.id), ['pmsg_a', 'pmsg_b', 'ui_1']);
    assert.deepEqual(conv.messages[2], { id: 'ui_1', direction: 'outbound', text: 'hello from Ben', at: conv.messages[2].at, status: 'queued', author: 'u_ben' });
    const snap = await (await fetch(base + '/__grader/snapshot', { headers: grader })).json();
    assert.deepEqual(snap.workspaces.ws_acme.contacts[contact].inbound, ['pmsg_a', 'pmsg_b']);
  });

  it('a reply is idempotent by client_ref and goes through the same outbox as the grader', async () => {
    const ben = await signedIn('u_ben');
    const path = `/api/conversations/${encodeURIComponent('+14155550102')}/reply?workspace=ws_acme`;
    const [a, b] = await Promise.all([ben.send('POST', path, { text: 'once', client_ref: 'ui_twice' }), ben.send('POST', path, { text: 'once', client_ref: 'ui_twice' })]);
    assert.deepEqual([a.status, b.status], [202, 202]);
    const snap = await (await fetch(base + '/__grader/snapshot', { headers: grader })).json();
    assert.deepEqual(snap.workspaces.ws_acme.outbound, { ui_twice: 'queued' });
  });

  it('refuses writes that are not JSON (cross-site forms) and bad replies', async () => {
    const ben = await signedIn('u_ben');
    const c = encodeURIComponent('+14155550103');
    const form = await fetch(`${base}/api/conversations/${c}/reply?workspace=ws_acme`, { method: 'POST', headers: { cookie: ben.cookie(), 'content-type': 'application/x-www-form-urlencoded' }, body: 'text=hi&client_ref=f' });
    assert.equal(form.status, 415);
    assert.equal((await ben.send('POST', `/api/conversations/${c}/reply?workspace=ws_acme`, { text: '', client_ref: 'r' })).status, 400);
    assert.equal((await ben.send('POST', `/api/conversations/${c}/reply?workspace=ws_acme`, { text: 'x'.repeat(4001), client_ref: 'r' })).status, 400);
    assert.equal((await ben.send('POST', `/api/conversations/${c}/reply?workspace=ws_acme`, { text: 'hi' })).status, 400);
  });

  it('claim uses the signed-in user: Ben wins, Eli then gets 409, Ben again 200', async () => {
    const c = encodeURIComponent('+12125550104');
    const ben = await signedIn('u_ben');
    const eli = await signedIn('u_eli');
    assert.equal((await ben.send('POST', `/api/conversations/${c}/claim?workspace=ws_acme`, {})).status, 200);
    const lost = await eli.send('POST', `/api/conversations/${c}/claim?workspace=ws_acme`, {});
    assert.equal(lost.status, 409);
    assert.deepEqual(await lost.json(), { assignee: 'u_ben' });
    assert.equal((await ben.send('POST', `/api/conversations/${c}/claim?workspace=ws_acme`, {})).status, 200);
    const snap = await (await fetch(base + '/__grader/snapshot', { headers: grader })).json();
    assert.equal(snap.workspaces.ws_acme.contacts['+12125550104'].assignee, 'u_ben');
  });

  it('close and reopen; the list can filter by status; unknown conversations are 404', async () => {
    await reply('ws_acme', '+12125550105', 'c1');
    await reply('ws_acme', '+13035550106', 'c2');
    const ben = await signedIn('u_ben');
    const c = encodeURIComponent('+12125550105');
    assert.equal((await (await ben.send('POST', `/api/conversations/${c}/close?workspace=ws_acme`, {})).json()).status, 'closed');
    const open = await ben.json('/api/conversations?workspace=ws_acme&status=open');
    assert.deepEqual(open.conversations.map((x: { contact: string }) => x.contact), ['+13035550106']);
    assert.equal((await (await ben.send('POST', `/api/conversations/${c}/reopen?workspace=ws_acme`, {})).json()).status, 'open');
    assert.equal((await ben.send('POST', `/api/conversations/${encodeURIComponent('+19999999999')}/close?workspace=ws_acme`, {})).status, 404);
    assert.equal((await ben.get(`/api/conversations/${encodeURIComponent('+19999999999')}?workspace=ws_acme`)).status, 404);
  });
});
