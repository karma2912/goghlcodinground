import { isDuplicateKey, messages } from '../db.js';
import { touchConversation } from './conversations.js';

export interface InboundMessage {
  workspace: string;
  contact: string; // Pigeon's data.from
  messageId: string; // Pigeon's data.message_id
  text: string;
  occurredAt: Date;
  eventId: string | null;
}

/**
 * Store an inbound message once. Pigeon delivers at least once, so the same
 * message can arrive many times, possibly concurrently: the unique index on
 * (workspace, messageId) keeps one copy, and a duplicate counts as success.
 *
 * Both writes are idempotent and run on every delivery, so a crash between
 * them is repaired by Pigeon's retry (we only answer 2xx after both).
 */
export async function recordInbound(msg: InboundMessage): Promise<{ created: boolean }> {
  let created = true;
  try {
    await (await messages()).insertOne({
      workspace: msg.workspace,
      contact: msg.contact,
      direction: 'inbound',
      messageId: msg.messageId,
      text: msg.text,
      occurredAt: msg.occurredAt,
      createdAt: new Date(),
      eventId: msg.eventId,
    });
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    created = false;
  }
  await touchConversation(msg.workspace, msg.contact, msg.occurredAt);
  return { created };
}
