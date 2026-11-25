import { isDuplicateKey, messages } from '../db.js';
import { publishEvent } from '../realtime/events.js';
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
 * Store an inbound message once and announce it once. Pigeon delivers at
 * least once, so the same message can arrive many times, possibly
 * concurrently: the unique index on (workspace, messageId) keeps one copy,
 * and a duplicate counts as success.
 *
 * The frame goes out only for a newly stored message. An `emitted` flag,
 * flipped atomically before publishing, makes sure that holds even when
 * deliveries race, and lets a redelivery finish the job if we crashed (or
 * Redis failed) after storing but before publishing. Every step is
 * idempotent, and we answer 2xx only after all of them.
 */
export async function recordInbound(msg: InboundMessage): Promise<{ created: boolean }> {
  const col = await messages();
  let created = true;
  try {
    await col.insertOne({
      workspace: msg.workspace,
      contact: msg.contact,
      direction: 'inbound',
      messageId: msg.messageId,
      text: msg.text,
      occurredAt: msg.occurredAt,
      createdAt: new Date(),
      eventId: msg.eventId,
      emitted: false,
    });
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    created = false;
  }
  await touchConversation(msg.workspace, msg.contact, msg.occurredAt);

  // Only one delivery wins the right to announce it.
  const key = { workspace: msg.workspace, messageId: msg.messageId };
  const mine = await col.findOneAndUpdate({ ...key, emitted: false }, { $set: { emitted: true } }, { projection: { text: 1, occurredAt: 1, contact: 1 } });
  if (mine) {
    try {
      await publishEvent(msg.workspace, {
        type: 'message.inbound',
        contact: mine.contact,
        message_id: msg.messageId,
        text: mine.text,
        occurred_at: (mine.occurredAt ?? msg.occurredAt).toISOString(),
      });
    } catch (err) {
      // Give the announcement back, and fail so Pigeon redelivers and we retry.
      await col.updateOne(key, { $set: { emitted: false } }).catch(() => undefined);
      throw err;
    }
  }
  return { created };
}
