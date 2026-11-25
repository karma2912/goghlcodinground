// Pure functions that apply a live frame to what the screen holds. Kept apart
// from the components so the rules are easy to read (and to test).
import { STATUS_RANK, type Conversation, type ConversationStatus, type ConversationSummary, type Message } from './api';
import type { Frame } from './live';

export type Filter = ConversationStatus | 'all';

/** A message as the screen holds it: a reply may still be on its way to the server. */
export type LocalMessage = Message & { sending?: boolean; error?: string };
export type Thread = Omit<Conversation, 'messages'> & { messages: LocalMessage[] };

const byActivity = (a: ConversationSummary, b: ConversationSummary) => (a.lastActivityAt < b.lastActivityAt ? 1 : a.lastActivityAt > b.lastActivityAt ? -1 : 0);
const later = (a: string, b: string) => (a > b ? a : b);

/**
 * The inbox list after a frame. Returns `reload: true` when the frame
 * concerns a conversation we cannot place without asking the server.
 */
export function applyToList(items: ConversationSummary[], f: Frame, filter: Filter): { items: ConversationSummary[]; reload: boolean } {
  const i = items.findIndex((c) => c.contact === f.contact);
  const existing = i >= 0 ? items[i] : null;
  const shown = (status: ConversationStatus) => filter === 'all' || filter === status;
  let next = items.slice();

  switch (f.type) {
    case 'message.inbound':
    case 'message.outbound': {
      const at = f.type === 'message.inbound' ? f.occurred_at : new Date().toISOString();
      if (existing) next[i] = { ...existing, lastActivityAt: later(existing.lastActivityAt, at) };
      else if (shown('open')) next.push({ contact: f.contact, assignee: null, status: 'open', lastActivityAt: at }); // a new conversation
      else return { items, reload: false };
      break;
    }
    case 'conversation.assigned':
      if (!existing) return { items, reload: false };
      next[i] = { ...existing, assignee: f.assignee };
      break;
    case 'conversation.status':
      if (!existing) return { items, reload: shown(f.status) };
      if (!shown(f.status)) next = next.filter((c) => c.contact !== f.contact);
      else next[i] = { ...existing, status: f.status };
      break;
    default:
      return { items, reload: false };
  }
  return { items: next.sort(byActivity), reload: false };
}

const messageOrder = (a: LocalMessage, b: LocalMessage) => (a.at === b.at ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.at < b.at ? -1 : 1);

/** The open conversation after a frame about it. */
export function applyToThread(t: Thread, f: Frame): Thread {
  if (f.contact !== t.contact) return t;
  const has = (id: string) => t.messages.some((m) => m.id === id);
  switch (f.type) {
    case 'message.inbound':
      if (has(f.message_id)) return t;
      return { ...t, lastActivityAt: later(t.lastActivityAt, f.occurred_at), messages: [...t.messages, { id: f.message_id, direction: 'inbound' as const, text: f.text, at: f.occurred_at }].sort(messageOrder) };
    case 'message.outbound':
      if (has(f.client_ref)) return t; // our own reply, already on screen
      return { ...t, messages: [...t.messages, { id: f.client_ref, direction: 'outbound' as const, text: f.text, at: new Date().toISOString(), status: f.status, author: f.author }].sort(messageOrder) };
    case 'message.status':
      return { ...t, messages: t.messages.map((m) => (m.id === f.client_ref ? withStatus(m, f.status) : m)) };
    case 'conversation.assigned':
      return { ...t, assignee: f.assignee };
    case 'conversation.status':
      return { ...t, status: f.status };
    default:
      return t;
  }
}

/** Status only moves forward, so a late frame cannot undo "delivered". */
export function withStatus<M extends LocalMessage>(m: M, status: NonNullable<Message['status']>): M {
  if (m.status && STATUS_RANK[m.status] >= STATUS_RANK[status]) return m;
  return { ...m, status };
}

/** A fresh fetch of the thread, keeping replies that are still being sent. */
export function mergeFetched(fetched: Conversation, current: Thread | null): Thread {
  const pending = current && current.contact === fetched.contact ? current.messages.filter((m) => (m.sending || m.error) && !fetched.messages.some((x) => x.id === m.id)) : [];
  const kept = fetched.messages.map((m) => {
    const old = current?.contact === fetched.contact ? current.messages.find((x) => x.id === m.id) : undefined;
    return old?.status && m.status ? withStatus(m, old.status) : m;
  });
  return { ...fetched, messages: [...kept, ...pending].sort(messageOrder) };
}
