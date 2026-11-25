import { isDuplicateKey, messages, type MessageDoc } from '../db.js';
import { assertWorkspace, touchConversation } from './conversations.js';

export interface ReplyInput {
  workspace: string;
  contact: string;
  text: string;
  clientRef: string;
  author: string;
}

/**
 * Store a reply in the outbox as `queued`. Returning means it is durably in
 * MongoDB; the sender worker delivers it to Pigeon later. The unique index on
 * (workspace, clientRef) makes the same client_ref one reply, even when two
 * requests race: the loser gets a duplicate-key error and is treated as success.
 */
export async function createReply(input: ReplyInput): Promise<{ created: boolean }> {
  assertWorkspace(input.workspace);
  const now = new Date();
  await touchConversation(input.workspace, input.contact, now);
  const doc: MessageDoc = {
    workspace: input.workspace,
    contact: input.contact,
    direction: 'outbound',
    text: input.text,
    createdAt: now,
    clientRef: input.clientRef,
    status: 'queued',
    author: input.author,
    pigeonId: null,
    attempts: 0,
    nextAttemptAt: now,
    lockedUntil: null,
  };
  try {
    await (await messages()).insertOne(doc);
    return { created: true };
  } catch (err) {
    if (isDuplicateKey(err)) return { created: false };
    throw err;
  }
}
