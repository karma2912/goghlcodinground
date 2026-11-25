// Pure logic, no MongoDB or Redis needed.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseWorkspaces } from '../scaffold/server/src/config.js';
import { tokenMatches } from '../scaffold/server/src/routes/grader.js';

describe('parseWorkspaces', () => {
  it('derives a workspace id from each PIGEON_KEY_WS_* variable', () => {
    const ws = parseWorkspaces({ PIGEON_KEY_WS_ACME: 'pk_a', PIGEON_KEY_WS_GLOBEX: 'pk_g', PIGEON_URL: 'http://x' });
    assert.deepEqual(ws, { ws_acme: 'pk_a', ws_globex: 'pk_g' });
  });

  it('ignores empty keys and a bare prefix', () => {
    assert.deepEqual(parseWorkspaces({ PIGEON_KEY_WS_: 'pk', PIGEON_KEY_WS_EMPTY: '' }), {});
  });
});

describe('tokenMatches', () => {
  it('accepts the exact token', () => assert.equal(tokenMatches('secret-token', 'secret-token'), true));
  it('rejects a wrong token of the same length', () => assert.equal(tokenMatches('secret-tokeN', 'secret-token'), false));
  it('rejects a token of a different length', () => assert.equal(tokenMatches('secret', 'secret-token'), false));
  it('rejects a missing header', () => assert.equal(tokenMatches(undefined, 'secret-token'), false));
  it('rejects everything when no token is configured', () => assert.equal(tokenMatches('', ''), false));
});
