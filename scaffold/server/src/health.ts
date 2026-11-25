import { ensureIndexes, getDb } from './db.js';
import { getRedis } from './redis.js';

let initialised = false;

/**
 * Connects to MongoDB and creates indexes, retrying until it works.
 * /healthz stays 503 until this has finished, so no traffic arrives before
 * the unique indexes that make webhooks and replies idempotent exist.
 */
export async function initialise(opts: { beforeReady?: () => Promise<void> } = {}): Promise<void> {
  for (;;) {
    try {
      await ensureIndexes();
      break;
    } catch (err) {
      console.error('startup: MongoDB not ready, retrying in 1 s:', (err as Error).message);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await opts.beforeReady?.(); // e.g. the realtime hub subscribing to Redis
  initialised = true;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

async function probe(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await withTimeout(fn(), 1000);
    return true;
  } catch {
    return false;
  }
}

export interface Health {
  ok: boolean;
  initialised: boolean;
  mongo: boolean;
  redis: boolean;
}

/** Ready for traffic: started up, and MongoDB and Redis both answer a ping now. */
export async function checkHealth(): Promise<Health> {
  const [mongo, redis] = await Promise.all([
    probe(async () => (await getDb()).command({ ping: 1 })),
    probe(() => getRedis().ping()),
  ]);
  return { ok: initialised && mongo && redis, initialised, mongo, redis };
}
