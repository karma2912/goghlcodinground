// Outbox logic with no I/O: status ranking, backoff, Retry-After.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canAdvance, replaceableBy } from '../scaffold/server/src/services/status.js';
import { backoffMs } from '../scaffold/server/src/outbox/worker.js';
import { parseRetryAfter } from '../scaffold/server/src/outbox/pigeonClient.js';

describe('status ranking', () => {
  it('moves forward', () => {
    assert.equal(canAdvance('queued', 'sent'), true);
    assert.equal(canAdvance('queued', 'delivered'), true);
    assert.equal(canAdvance('sent', 'delivered'), true);
    assert.equal(canAdvance('sent', 'failed'), true);
  });
  it('never overwrites delivered or failed', () => {
    for (const to of ['queued', 'sent', 'delivered', 'failed'] as const) {
      assert.equal(canAdvance('delivered', to), false, `delivered -> ${to}`);
      assert.equal(canAdvance('failed', to), false, `failed -> ${to}`);
    }
  });
  it('a late sent does not undo delivered', () => assert.deepEqual(replaceableBy('sent'), ['queued']));
});

describe('backoffMs', () => {
  const mid = () => 0.5; // no jitter
  it('doubles from the base and stops at the cap', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 10].map((a) => backoffMs(a, 500, 8000, mid)), [500, 1000, 2000, 4000, 8000, 8000, 8000]);
  });
  it('jitters within ±20 %', () => {
    assert.equal(backoffMs(1, 1000, 8000, () => 0), 800);
    assert.equal(backoffMs(1, 1000, 8000, () => 1), 1200);
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds', () => assert.equal(parseRetryAfter('2'), 2000));
  it('reads an HTTP date', () => assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 7_000), 3000));
  it('defaults to 2 s', () => assert.equal(parseRetryAfter(null), 2000));
});
