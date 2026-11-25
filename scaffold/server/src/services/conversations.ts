import { conversations, isDuplicateKey } from '../db.js';
import { workspaceExists } from '../config.js';
import { HttpError } from '../errors.js';
import { publishBestEffort } from '../realtime/events.js';

export function assertWorkspace(workspace: string): void {
  if (!workspaceExists(workspace)) throw new HttpError(404, `unknown workspace ${workspace}`);
}

/**
 * Make sure a conversation exists for (workspace, contact) and bump its
 * activity time. Safe under concurrency: the unique index decides, and a
 * losing upsert is retried as a plain update.
 */
export async function touchConversation(workspace: string, contact: string, at: Date = new Date()): Promise<void> {
  const col = await conversations();
  const filter = { workspace, contact };
  const update = {
    $max: { lastActivityAt: at },
    $setOnInsert: { assignee: null, status: 'open' as const, createdAt: at },
  };
  try {
    await col.updateOne(filter, update, { upsert: true });
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    await col.updateOne(filter, { $max: { lastActivityAt: at } });
  }
}

export type ClaimResult = { ok: true; assignee: string } | { ok: false; assignee: string | null };

/**
 * Atomically claim a conversation for `agent`. Exactly one agent can hold it.
 * The holder claiming again succeeds. Creates the conversation if the contact
 * has never written.
 *
 * One conditional upsert: it matches only when the conversation is free or
 * already ours. If someone else holds it, the filter misses, the upsert tries
 * to insert a second (workspace, contact) and the unique index refuses it.
 */
export async function claimConversation(workspace: string, contact: string, agent: string): Promise<ClaimResult> {
  assertWorkspace(workspace);
  const col = await conversations();
  const now = new Date();
  const freeOrMine = { workspace, contact, $or: [{ assignee: null }, { assignee: agent }] };
  const take = { $set: { assignee: agent } };
  // Success means the filter matched (free or ours) or the upsert inserted.
  // 'before' tells a new assignment apart from the holder claiming again.
  const won = (before: { assignee: string | null } | null): ClaimResult => {
    if (!before || before.assignee !== agent) publishBestEffort(workspace, { type: 'conversation.assigned', contact, assignee: agent });
    return { ok: true, assignee: agent };
  };
  try {
    const before = await col.findOneAndUpdate(
      freeOrMine,
      { ...take, $setOnInsert: { status: 'open' as const, createdAt: now, lastActivityAt: now } },
      { upsert: true, returnDocument: 'before', projection: { assignee: 1 } },
    );
    return won(before);
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    // Lost an insert race, or the conversation is held by someone else.
    // Try once more without upsert: it now exists, so this is a plain CAS.
    const before = await col.findOneAndUpdate(freeOrMine, take, { returnDocument: 'before', projection: { assignee: 1 } });
    if (before) return won(before);
  }
  const current = await col.findOne({ workspace, contact }, { projection: { assignee: 1 } });
  return { ok: false, assignee: current?.assignee ?? null };
}
