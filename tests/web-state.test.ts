// The web app's live-update rules (pure functions, no browser needed).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyToList, applyToThread, mergeFetched, type Thread } from '../scaffold/web/src/inbox-state.ts';

const item = (contact: string, at: string, extra = {}) => ({ contact, assignee: null, status: 'open' as const, lastActivityAt: at, ...extra });
const inbound = (contact: string, id: string, at: string) => ({ seq: 1, type: 'message.inbound' as const, contact, message_id: id, text: 'hi', occurred_at: at });

describe('applyToList', () => {
  it('a new message moves its conversation to the top', () => {
    const r = applyToList([item('+1', '2026-11-25T10:00:00Z'), item('+2', '2026-11-25T09:00:00Z')], inbound('+2', 'm', '2026-11-25T11:00:00Z'), 'open');
    assert.deepEqual(r.items.map((c) => c.contact), ['+2', '+1']);
  });
  it('a message from a new contact adds an open conversation, but not to the Closed tab', () => {
    assert.deepEqual(applyToList([], inbound('+9', 'm', '2026-11-25T11:00:00Z'), 'open').items.map((c) => c.contact), ['+9']);
    assert.deepEqual(applyToList([], inbound('+9', 'm', '2026-11-25T11:00:00Z'), 'closed').items, []);
  });
  it('closing removes it from the Open tab; an unknown one that now matches asks for a reload', () => {
    const closed = { seq: 2, type: 'conversation.status' as const, contact: '+1', status: 'closed' as const };
    assert.deepEqual(applyToList([item('+1', 'x')], closed, 'open').items, []);
    assert.equal(applyToList([], closed, 'closed').reload, true);
  });
  it('an assignment updates the assignee', () => {
    const r = applyToList([item('+1', 'x')], { seq: 3, type: 'conversation.assigned', contact: '+1', assignee: 'u_ben' }, 'all');
    assert.equal(r.items[0].assignee, 'u_ben');
  });
});

describe('applyToThread', () => {
  const thread = (): Thread => ({ contact: '+1', assignee: null, status: 'open', lastActivityAt: 'x', messages: [{ id: 'r1', direction: 'outbound', text: 'hello', at: '2026-11-25T10:00:00Z', status: 'queued' }] });

  it('adds an inbound message once, in time order', () => {
    let t = applyToThread(thread(), inbound('+1', 'm0', '2026-11-25T09:00:00Z'));
    t = applyToThread(t, inbound('+1', 'm0', '2026-11-25T09:00:00Z'));
    assert.deepEqual(t.messages.map((m) => m.id), ['m0', 'r1']);
  });
  it('ignores frames about other conversations', () => {
    const t = thread();
    assert.equal(applyToThread(t, inbound('+2', 'm', 'x')), t);
  });
  it('does not duplicate our own reply when its message.outbound frame arrives', () => {
    const t = applyToThread(thread(), { seq: 4, type: 'message.outbound', contact: '+1', client_ref: 'r1', text: 'hello', status: 'queued', author: 'u_ben' });
    assert.equal(t.messages.length, 1);
  });
  it('status only moves forward', () => {
    let t = applyToThread(thread(), { seq: 5, type: 'message.status', contact: '+1', client_ref: 'r1', status: 'delivered' });
    t = applyToThread(t, { seq: 6, type: 'message.status', contact: '+1', client_ref: 'r1', status: 'sent' });
    assert.equal(t.messages[0].status, 'delivered');
  });
});

describe('mergeFetched', () => {
  it('keeps a reply that is still sending and a status newer than the fetch', () => {
    const current: Thread = {
      contact: '+1', assignee: null, status: 'open', lastActivityAt: 'x',
      messages: [
        { id: 'r1', direction: 'outbound', text: 'a', at: '2026-11-25T10:00:00Z', status: 'delivered' },
        { id: 'r2', direction: 'outbound', text: 'b', at: '2026-11-25T10:01:00Z', status: 'queued', sending: true },
      ],
    };
    const fetched = { contact: '+1', assignee: null, status: 'open' as const, lastActivityAt: 'x', messages: [{ id: 'r1', direction: 'outbound' as const, text: 'a', at: '2026-11-25T10:00:00Z', status: 'sent' as const }] };
    const t = mergeFetched(fetched, current);
    assert.deepEqual(t.messages.map((m) => [m.id, m.status]), [['r1', 'delivered'], ['r2', 'queued']]);
  });
});
