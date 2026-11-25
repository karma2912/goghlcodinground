import { MongoClient, MongoServerError, type Collection, type Db } from 'mongodb';
import { config } from './config.js';

// ---------------------------------------------------------------- documents

export type OutboundStatus = 'queued' | 'sent' | 'delivered' | 'failed';
export type ConversationStatus = 'open' | 'closed';

export interface ConversationDoc {
  workspace: string;
  contact: string;
  assignee: string | null;
  status: ConversationStatus;
  createdAt: Date;
  lastActivityAt: Date;
}

/** One message in a conversation, either direction. */
export interface MessageDoc {
  workspace: string;
  contact: string;
  direction: 'inbound' | 'outbound';
  text: string;
  createdAt: Date;
  // inbound only
  messageId?: string; // Pigeon's pmsg_ id
  occurredAt?: Date;
  // outbound only
  clientRef?: string;
  status?: OutboundStatus;
  author?: string; // agent id that wrote the reply
  pigeonId?: string | null; // Pigeon's pm_ id once accepted
  attempts?: number;
  nextAttemptAt?: Date; // when the sender may try again
  lockedUntil?: Date | null; // lease held by a sender worker
}

// --------------------------------------------------------------- connection

let clientPromise: Promise<MongoClient> | undefined;

// Connects on first use; concurrent callers share one connection attempt.
export async function getDb(): Promise<Db> {
  if (!clientPromise) {
    const client = new MongoClient(config.mongoUrl, { serverSelectionTimeoutMS: 3000 });
    clientPromise = client.connect().catch((err) => {
      clientPromise = undefined; // let the next caller try again
      throw err;
    });
  }
  return (await clientPromise).db();
}

export async function conversations(): Promise<Collection<ConversationDoc>> {
  return (await getDb()).collection<ConversationDoc>('conversations');
}

export async function messages(): Promise<Collection<MessageDoc>> {
  return (await getDb()).collection<MessageDoc>('messages');
}

/** Idempotent: safe to run on every start of every instance. */
export async function ensureIndexes(): Promise<void> {
  const conv = await conversations();
  await conv.createIndex({ workspace: 1, contact: 1 }, { unique: true });
  await conv.createIndex({ workspace: 1, lastActivityAt: -1 });

  const msg = await messages();
  // an inbound Pigeon message is stored once
  await msg.createIndex(
    { workspace: 1, messageId: 1 },
    { unique: true, partialFilterExpression: { messageId: { $exists: true } } },
  );
  // a reply (client_ref) is stored once
  await msg.createIndex(
    { workspace: 1, clientRef: 1 },
    { unique: true, partialFilterExpression: { clientRef: { $exists: true } } },
  );
  // thread view and snapshot: oldest first, by occurred_at then message id
  await msg.createIndex({ workspace: 1, contact: 1, direction: 1, occurredAt: 1, messageId: 1 });
  // the sender worker looks for due replies
  await msg.createIndex({ status: 1, nextAttemptAt: 1 }, { partialFilterExpression: { direction: 'outbound' } });
}

export function isDuplicateKey(err: unknown): boolean {
  return err instanceof MongoServerError && err.code === 11000;
}

/** For tests and shutdown. */
export async function closeDb(): Promise<void> {
  const pending = clientPromise;
  clientPromise = undefined;
  if (pending) await (await pending).close();
}
