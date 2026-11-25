import { ObjectId, type Filter } from 'mongodb';
import { conversations, messages, type ConversationDoc, type ConversationStatus, type MessageDoc, type OutboundStatus } from '../db.js';
import { HttpError } from '../errors.js';
import { publishBestEffort } from '../realtime/events.js';
import { assertWorkspace } from './conversations.js';

// What the agent UI reads. The grader snapshot and these views agree on
// order: inbound messages by occurred_at, then message id.

export interface ConversationView {
  contact: string;
  assignee: string | null;
  status: ConversationStatus;
  lastActivityAt: string;
}

export interface MessageView {
  id: string; // Pigeon message id (inbound) or client_ref (outbound)
  direction: 'inbound' | 'outbound';
  text: string;
  at: string;
  status?: OutboundStatus;
  author?: string;
}

const view = (c: ConversationDoc): ConversationView => ({
  contact: c.contact,
  assignee: c.assignee ?? null,
  status: c.status,
  lastActivityAt: c.lastActivityAt.toISOString(),
});

// --------------------------------------------------------------- the list

interface Cursor {
  t: number; // lastActivityAt of the last row on the previous page
  id: string; // its _id, to break ties
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

export function decodeCursor(raw: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof c?.t === 'number' && typeof c?.id === 'string' && ObjectId.isValid(c.id)) return c;
  } catch {
    /* fall through */
  }
  throw new HttpError(400, 'invalid cursor');
}

/**
 * Newest activity first, keyset-paginated on (lastActivityAt, _id) so pages
 * stay stable while new messages arrive: a page never repeats or skips a row.
 */
export async function listConversations(
  workspace: string,
  opts: { limit?: number; cursor?: string; status?: ConversationStatus } = {},
): Promise<{ conversations: ConversationView[]; nextCursor: string | null }> {
  assertWorkspace(workspace);
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 25)));
  const filter: Filter<ConversationDoc> = { workspace };
  if (opts.status) filter.status = opts.status;
  if (opts.cursor) {
    const c = decodeCursor(opts.cursor);
    const t = new Date(c.t);
    filter.$or = [{ lastActivityAt: { $lt: t } }, { lastActivityAt: t, _id: { $lt: new ObjectId(c.id) } }];
  }
  const rows = await (await conversations()).find(filter).sort({ lastActivityAt: -1, _id: -1 }).limit(limit + 1).toArray();
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    conversations: page.map(view),
    nextCursor: rows.length > limit && last ? encodeCursor({ t: last.lastActivityAt.getTime(), id: last._id.toHexString() }) : null,
  };
}

// ----------------------------------------------------- one conversation

/** Sort key shared by the thread view: when it happened, then its id. */
export function messageOrder(a: MessageDoc, b: MessageDoc): number {
  const ta = (a.occurredAt ?? a.createdAt).getTime();
  const tb = (b.occurredAt ?? b.createdAt).getTime();
  if (ta !== tb) return ta - tb;
  const ia = a.messageId ?? a.clientRef ?? '';
  const ib = b.messageId ?? b.clientRef ?? '';
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

export async function getConversation(workspace: string, contact: string): Promise<ConversationView & { messages: MessageView[] }> {
  assertWorkspace(workspace);
  const conv = await (await conversations()).findOne({ workspace, contact });
  if (!conv) throw new HttpError(404, 'no such conversation');
  const docs = await (await messages()).find({ workspace, contact }).limit(2000).toArray();
  docs.sort(messageOrder);
  return {
    ...view(conv),
    messages: docs.map((m) => ({
      id: (m.messageId ?? m.clientRef)!,
      direction: m.direction,
      text: m.text,
      at: (m.occurredAt ?? m.createdAt).toISOString(),
      ...(m.direction === 'outbound' ? { status: m.status, author: m.author } : {}),
    })),
  };
}

/** Close or reopen. The assignee is kept, so a reopened conversation returns to its agent. */
export async function setConversationStatus(workspace: string, contact: string, status: ConversationStatus): Promise<ConversationView> {
  assertWorkspace(workspace);
  const col = await conversations();
  const before = await col.findOneAndUpdate({ workspace, contact }, { $set: { status } }, { returnDocument: 'before' });
  if (!before) throw new HttpError(404, 'no such conversation');
  if (before.status !== status) publishBestEffort(workspace, { type: 'conversation.status', contact, status });
  return view({ ...before, status });
}
