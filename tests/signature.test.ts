// The Pigeon signature check, with no I/O.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeSignature, parseSignatureHeader, verifySignature } from '../scaffold/server/src/webhooks/signature.js';

const secret = 'whsec_test';
const now = 1_800_000_000;
const body = Buffer.from('{"type":"message.inbound","workspace":"ws_acme"}');
const header = (t: number, b: Buffer = body, s: string = secret) => `t=${t},v1=${computeSignature(s, t, b).toString('hex')}`;
const verify = (h: unknown, b: Buffer = body) => verifySignature({ header: h, rawBody: b, secret, nowSeconds: now });

describe('verifySignature', () => {
  it('accepts a correct signature with a current timestamp', () => {
    assert.deepEqual(verify(header(now)), { ok: true, timestamp: now });
  });

  it('rejects a missing header', () => assert.deepEqual(verify(undefined), { ok: false, reason: 'missing' }));

  it('rejects a body changed by one byte', () => {
    assert.deepEqual(verify(header(now), Buffer.from(body.toString().replace('acme', 'acmf'))), { ok: false, reason: 'mismatch' });
  });

  it('rejects a signature made with another secret', () => {
    assert.deepEqual(verify(header(now, body, 'not-the-secret')), { ok: false, reason: 'mismatch' });
  });

  it('rejects a valid signature whose timestamp was changed', () => {
    const sig = computeSignature(secret, now - 3600, body).toString('hex');
    assert.deepEqual(verify(`t=${now},v1=${sig}`), { ok: false, reason: 'mismatch' });
  });

  it('accepts exactly 5 minutes old, rejects 5 minutes and 1 second', () => {
    assert.equal(verify(header(now - 300)).ok, true);
    assert.deepEqual(verify(header(now - 301)), { ok: false, reason: 'expired' });
  });

  it('rejects a timestamp more than 5 minutes in the future', () => {
    assert.equal(verify(header(now + 300)).ok, true);
    assert.deepEqual(verify(header(now + 301)), { ok: false, reason: 'expired' });
  });

  it('rejects a replay from an hour ago even though it is genuinely signed', () => {
    assert.deepEqual(verify(header(now - 3600)), { ok: false, reason: 'expired' });
  });

  it('accepts when any one of several v1 values matches', () => {
    const good = computeSignature(secret, now, body).toString('hex');
    assert.equal(verify(`t=${now},v1=${'0'.repeat(64)},v1=${good}`).ok, true);
  });
});

describe('parseSignatureHeader', () => {
  const v1 = 'a'.repeat(64);
  for (const bad of ['', 'garbage', `v1=${v1}`, `t=${now}`, `t=abc,v1=${v1}`, `t=${now},v1=xyz`, `t=${now},v1=${'a'.repeat(63)}`, `t=1,t=2,v1=${v1}`, `t=${now},v1`]) {
    it(`rejects ${JSON.stringify(bad)}`, () => assert.equal(parseSignatureHeader(bad), null));
  }
  it('rejects a non-string', () => assert.equal(parseSignatureHeader(['t=1']), null));
  it('ignores unknown schemes', () => assert.equal(parseSignatureHeader(`t=${now},v0=zz,v1=${v1}`)?.signatures.length, 1));
});
