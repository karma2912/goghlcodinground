import { config } from '../config.js';

export type SendOutcome =
  | { kind: 'accepted'; pigeonId: string | null }
  | { kind: 'rate_limited'; retryAfterMs: number }
  | { kind: 'retry'; reason: string } // 5xx, timeout, network: try again later
  | { kind: 'rejected'; reason: string }; // 4xx: Pigeon will never take it

export interface SendRequest {
  workspace: string;
  to: string;
  text: string;
  clientRef: string;
}

/** Retry-After is seconds (or an HTTP date). Defaults to 2 s, Pigeon's usual. */
export function parseRetryAfter(header: string | null, now = Date.now()): number {
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  return 2000;
}

/**
 * One HTTP attempt. The Idempotency-Key is the client_ref, identical on every
 * retry and from every instance, so Pigeon sends a reply at most once even
 * when an earlier attempt timed out after Pigeon had accepted it.
 */
export async function sendToPigeon(req: SendRequest): Promise<SendOutcome> {
  const apiKey = config.pigeon.apiKeys[req.workspace];
  if (!apiKey) return { kind: 'rejected', reason: `no Pigeon key for ${req.workspace}` };
  let res: Response;
  try {
    res = await fetch(`${config.pigeon.url}/v1/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': req.clientRef,
      },
      body: JSON.stringify({ to: req.to, text: req.text, client_ref: req.clientRef }),
      signal: AbortSignal.timeout(config.pigeon.sendTimeoutMs),
    });
  } catch (err) {
    const name = (err as Error).name;
    return { kind: 'retry', reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : `network: ${(err as Error).message}` };
  }

  if (res.status === 200 || res.status === 201 || res.status === 202) {
    const body = (await res.json().catch(() => ({}))) as { id?: unknown };
    return { kind: 'accepted', pigeonId: typeof body.id === 'string' ? body.id : null };
  }
  await res.body?.cancel().catch(() => undefined);
  if (res.status === 429) return { kind: 'rate_limited', retryAfterMs: parseRetryAfter(res.headers.get('retry-after')) };
  if (res.status >= 500 || res.status === 408) return { kind: 'retry', reason: `HTTP ${res.status}` };
  return { kind: 'rejected', reason: `HTTP ${res.status}` };
}
