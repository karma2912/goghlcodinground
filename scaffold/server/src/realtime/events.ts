import { config } from '../config.js';
import { APP_PREFIX, getRedis } from '../redis.js';

// The event log: one Redis Stream per workspace. Every frame gets the next
// `seq` of its workspace, and the stream entry id IS that seq ("<seq>-0"), so
// "everything after 41" is one XRANGE. The stream is capped (~MAXLEN) for
// ?after= replay. Each append also PUBLISHes "<workspace> <seq>" so every
// instance learns about it at once and pushes it to its own sockets.

export type Frame =
  | { type: 'message.inbound'; contact: string; message_id: string; text: string; occurred_at: string }
  | { type: 'message.outbound'; contact: string; client_ref: string; text: string; status: string; author: string }
  | { type: 'message.status'; contact: string; client_ref: string; status: string }
  | { type: 'conversation.assigned'; contact: string; assignee: string | null }
  | { type: 'conversation.status'; contact: string; status: string };

export interface StoredFrame {
  seq: number;
  json: string; // the frame exactly as sent to clients, including seq
}

export const EVENTS_CHANNEL = `${APP_PREFIX}events`;
const seqKey = (workspace: string) => `${APP_PREFIX}seq:${workspace}`;
export const streamKey = (workspace: string) => `${APP_PREFIX}stream:${workspace}`;

// Atomic: number, append, announce. Because Redis runs the script alone,
// appends are strictly ordered by seq and announced in that order.
// The XREVRANGE guard keeps ids rising even if the counter was deleted
// without the stream (they share a prefix, so reset normally drops both).
const APPEND = `
local seq = redis.call('INCR', KEYS[1])
local last = redis.call('XREVRANGE', KEYS[2], '+', '-', 'COUNT', 1)
if #last > 0 then
  local lastSeq = tonumber(string.match(last[1][1], '^(%d+)'))
  if seq <= lastSeq then
    seq = lastSeq + 1
    redis.call('SET', KEYS[1], seq)
  end
end
local frame = '{"seq":' .. seq .. ',' .. string.sub(ARGV[1], 2)
redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[2], seq .. '-0', 'json', frame)
redis.call('PUBLISH', ARGV[3], ARGV[4] .. ' ' .. seq)
return seq
`;

/** Append a frame to the workspace's log and announce it. Returns its seq. */
export async function publishEvent(workspace: string, frame: Frame): Promise<number> {
  const body = JSON.stringify(frame); // starts with '{"type":', so it has fields
  const seq = await getRedis().eval(APPEND, 2, seqKey(workspace), streamKey(workspace), body, String(config.realtime.streamMaxLen), EVENTS_CHANNEL, workspace);
  return Number(seq);
}

/**
 * For changes already safely stored in MongoDB, where the frame is a courtesy
 * to open browsers (they refetch on reconnect): log a failure, never fail the
 * request that made the change.
 */
export function publishBestEffort(workspace: string, frame: Frame): void {
  publishEvent(workspace, frame).catch((err) => console.error(`realtime: could not publish ${frame.type}:`, (err as Error).message));
}

/** Frames with seq > after, oldest first. */
export async function readAfter(workspace: string, after: number, count: number): Promise<StoredFrame[]> {
  const rows = await getRedis().xrange(streamKey(workspace), `${after + 1}-0`, '+', 'COUNT', count);
  return rows.map(([id, fields]) => ({ seq: Number(id.split('-')[0]), json: fields[fields.indexOf('json') + 1] }));
}

/** The newest seq in the log (0 when empty) and the oldest still kept (null when empty). */
export async function streamBounds(workspace: string): Promise<{ last: number; first: number | null }> {
  const r = getRedis();
  const [newest, oldest] = await Promise.all([
    r.xrevrange(streamKey(workspace), '+', '-', 'COUNT', 1),
    r.xrange(streamKey(workspace), '-', '+', 'COUNT', 1),
  ]);
  return {
    last: newest.length ? Number(newest[0][0].split('-')[0]) : 0,
    first: oldest.length ? Number(oldest[0][0].split('-')[0]) : null,
  };
}
