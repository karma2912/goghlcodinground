// Login building blocks with no I/O: id_token verification, PKCE, cookies, claims.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, it } from 'node:test';
import { parseCookies, serializeCookie } from '../scaffold/server/src/auth/cookies.js';
import { parseWorkspacesClaim, pkceChallenge, verifyIdToken } from '../scaffold/server/src/auth/oidc.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const b64 = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64url');
const now = 1_800_000_000;
const good = { iss: 'http://idp', aud: 'switchboard-web', sub: 'u_ben', iat: now, exp: now + 3600, nonce: 'n1', name: 'Ben', email: 'ben@acme.test', workspaces: [{ id: 'ws_acme', role: 'agent' }] };

function jwt(claims: Record<string, unknown>, opts: { alg?: string; key?: typeof privateKey } = {}) {
  const head = b64({ alg: opts.alg ?? 'RS256', typ: 'JWT', kid: 'k1' });
  const body = b64(claims);
  const sig = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), opts.key ?? privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}
const check = (token: string) => verifyIdToken(token, { key: publicKey, issuer: 'http://idp', clientId: 'switchboard-web', nonce: 'n1', nowSeconds: now });

describe('verifyIdToken', () => {
  it('returns the identity for a valid token', () => {
    assert.deepEqual(check(jwt(good)), { sub: 'u_ben', name: 'Ben', email: 'ben@acme.test', workspaces: [{ id: 'ws_acme', role: 'agent' }] });
  });
  it('accepts an audience array that contains us', () => assert.equal(check(jwt({ ...good, aud: ['other', 'switchboard-web'] })).sub, 'u_ben'));

  const rejects: [string, () => string, RegExp][] = [
    ['a token signed by another key', () => jwt(good, { key: other.privateKey }), /signature/],
    ['a changed payload', () => { const [h, , s] = jwt(good).split('.'); return `${h}.${b64({ ...good, sub: 'u_asha' })}.${s}`; }, /signature/],
    ['alg none', () => { const [, p] = jwt(good).split('.'); return `${b64({ alg: 'none', kid: 'k1' })}.${p}.`; }, /alg/],
    ['alg HS256', () => jwt(good, { alg: 'HS256' }), /alg/],
    ['another issuer', () => jwt({ ...good, iss: 'http://evil' }), /issuer/],
    ['another audience', () => jwt({ ...good, aud: 'someone-else' }), /audience/],
    ['an expired token', () => jwt({ ...good, exp: now - 120 }), /expired/],
    ['a token from the future', () => jwt({ ...good, iat: now + 600 }), /future/],
    ['a wrong nonce (a replayed id_token)', () => jwt({ ...good, nonce: 'other' }), /nonce/],
    ['no nonce', () => jwt({ ...good, nonce: undefined }), /nonce/],
    ['no sub', () => jwt({ ...good, sub: '' }), /sub/],
    ['two parts', () => jwt(good).split('.').slice(0, 2).join('.'), /malformed/],
    ['garbage', () => 'not.a.jwt', /malformed/],
  ];
  for (const [name, make, msg] of rejects) it(`rejects ${name}`, () => assert.throws(() => check(make()), msg));
});

describe('pkceChallenge', () => {
  it('matches the RFC 7636 appendix B example', () => {
    assert.equal(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('parseWorkspacesClaim', () => {
  it('keeps well-formed entries with a known role, once each', () => {
    const claim = [{ id: 'ws_acme', role: 'agent' }, { id: 'ws_acme', role: 'admin' }, { id: 'ws_globex', role: 'owner' }, { id: '', role: 'agent' }, 'ws_x', null, { id: 'ws_globex', role: 'admin' }];
    assert.deepEqual(parseWorkspacesClaim(claim), [{ id: 'ws_acme', role: 'agent' }, { id: 'ws_globex', role: 'admin' }]);
  });
  it('grants nothing for a missing or odd claim', () => {
    assert.deepEqual(parseWorkspacesClaim(undefined), []);
    assert.deepEqual(parseWorkspacesClaim('ws_acme'), []);
  });
});

describe('cookies', () => {
  it('parses a cookie header; the first of two same-named cookies wins', () => {
    assert.deepEqual(parseCookies('a=1; b=hello%20world; a=2; broken; c="q"'), { a: '1', b: 'hello world', c: 'q' });
    assert.deepEqual(parseCookies(undefined), {});
  });
  it('always sets HttpOnly and SameSite=Lax, and Secure when asked', () => {
    assert.equal(serializeCookie('s', 'v', { maxAgeSeconds: 60, secure: false }), 's=v; Path=/; Max-Age=60; HttpOnly; SameSite=Lax');
    assert.match(serializeCookie('s', 'v', { maxAgeSeconds: 60, secure: true, path: '/auth' }), /Path=\/auth; .*; Secure$/);
  });
});
