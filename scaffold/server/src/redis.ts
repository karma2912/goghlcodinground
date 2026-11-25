import { Redis } from 'ioredis';
import { config } from './config.js';

let redis: Redis | undefined;

// Connects on first use. Call from anywhere: const redis = getRedis();
export function getRedis(): Redis {
  if (!redis) redis = new Redis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 });
  return redis;
}

// Every key the app writes starts with one of these prefixes.
// POST /__grader/reset deletes APP_PREFIX keys only, so login sessions
// (SESSION_PREFIX) survive a reset.
export const APP_PREFIX = 'sb:app:';
export const SESSION_PREFIX = 'sb:session:';

/** Delete every key matching `prefix*` without blocking Redis (no KEYS, no FLUSHDB). */
export async function deleteByPrefix(prefix: string): Promise<number> {
  const r = getRedis();
  let cursor = '0';
  let deleted = 0;
  do {
    const [next, keys] = await r.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
    cursor = next;
    if (keys.length) deleted += await r.unlink(...keys);
  } while (cursor !== '0');
  return deleted;
}

/** For tests and shutdown. */
export async function closeRedis(): Promise<void> {
  const r = redis;
  redis = undefined;
  if (r) await r.quit();
}
