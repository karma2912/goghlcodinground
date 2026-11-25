import { messages, type OutboundStatus } from '../db.js';
import { publishBestEffort } from '../realtime/events.js';

/**
 * Status only moves forward: queued -> sent -> delivered | failed.
 * Pigeon's webhooks arrive out of order and duplicated (delivered before
 * sent is normal), so a late `sent` must not undo `delivered`, and the two
 * final states never replace each other.
 */
export const STATUS_RANK: Record<OutboundStatus, number> = { queued: 0, sent: 1, delivered: 2, failed: 2 };

export function isOutboundStatus(v: unknown): v is OutboundStatus {
  return typeof v === 'string' && Object.hasOwn(STATUS_RANK, v);
}

/** The statuses that `to` may replace. */
export function replaceableBy(to: OutboundStatus): OutboundStatus[] {
  return (Object.keys(STATUS_RANK) as OutboundStatus[]).filter((s) => STATUS_RANK[s] < STATUS_RANK[to]);
}

export function canAdvance(from: OutboundStatus, to: OutboundStatus): boolean {
  return replaceableBy(to).includes(from);
}

export type StatusUpdate = { workspace: string; clientRef: string | null; pigeonId: string | null; status: OutboundStatus };

/**
 * Apply a status webhook. One conditional update, so concurrent webhooks for
 * the same reply cannot race a lower status past a higher one.
 * Returns 'unknown' when we never sent that message (the caller ignores it).
 */
export async function applyStatus(u: StatusUpdate): Promise<'advanced' | 'unchanged' | 'unknown'> {
  const col = await messages();
  const who = u.clientRef
    ? { workspace: u.workspace, direction: 'outbound' as const, clientRef: u.clientRef }
    : { workspace: u.workspace, direction: 'outbound' as const, pigeonId: u.pigeonId };

  // A status webhook proves Pigeon accepted the message: stop (re)sending it.
  const accepted = await col.updateOne(
    { ...who, sendState: 'pending' },
    { $set: { sendState: 'accepted', acceptedAt: new Date(), lockedUntil: null, ...(u.pigeonId ? { pigeonId: u.pigeonId } : {}) } },
  );

  const moved = await col.findOneAndUpdate({ ...who, status: { $in: replaceableBy(u.status) } }, { $set: { status: u.status } }, { projection: { contact: 1, clientRef: 1 } });
  if (moved) {
    publishBestEffort(u.workspace, { type: 'message.status', contact: moved.contact, client_ref: moved.clientRef!, status: u.status });
    return 'advanced';
  }
  if (accepted.matchedCount > 0) return 'unchanged';
  return (await col.countDocuments(who, { limit: 1 })) > 0 ? 'unchanged' : 'unknown';
}
