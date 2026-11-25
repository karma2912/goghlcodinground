import { config } from '../config.js';
import { APP_PREFIX, getRedis } from '../redis.js';

// Pigeon's limit is per workspace, so ours lives in Redis and every instance
// shares it. Two keys per workspace:
//   bucket   a token bucket a little stricter than Pigeon's (so we rarely hit 429)
//   cooloff  set after a 429 for Retry-After; nobody sends while it exists
// The script runs atomically in Redis and uses Redis's clock, so instances
// with skewed clocks still agree.
const TAKE = `
local bucket, cool = KEYS[1], KEYS[2]
local cap, perMs = tonumber(ARGV[1]), tonumber(ARGV[2])
local wait = redis.call('PTTL', cool)
if wait > 0 then return wait end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local b = redis.call('HMGET', bucket, 'tokens', 'at')
local tokens = tonumber(b[1]) or cap
local at = tonumber(b[2]) or now
tokens = math.min(cap, tokens + math.max(0, now - at) * perMs)
local result = 0
if tokens >= 1 then tokens = tokens - 1 else result = math.ceil((1 - tokens) / perMs) end
redis.call('HSET', bucket, 'tokens', tostring(tokens), 'at', tostring(now))
redis.call('PEXPIRE', bucket, 60000)
return result
`;

const keys = (workspace: string) => [`${APP_PREFIX}ratelimit:${workspace}:bucket`, `${APP_PREFIX}ratelimit:${workspace}:cooloff`];

/** 0 if this instance may send to `workspace` now (a token was taken), else ms to wait. */
export async function takeSendToken(workspace: string): Promise<number> {
  const [bucket, cool] = keys(workspace);
  const perMs = config.pigeon.ratePerSec / 1000;
  return Number(await getRedis().eval(TAKE, 2, bucket, cool, String(config.pigeon.rateBurst), String(perMs)));
}

/** After a 429: stop every instance sending to this workspace for Retry-After (+ a margin). */
export async function startCoolOff(workspace: string, ms: number): Promise<void> {
  const [, cool] = keys(workspace);
  await getRedis().set(cool, '1', 'PX', Math.max(1, Math.ceil(ms)));
}
