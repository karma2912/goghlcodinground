import { config } from '../config.js';

// Server -> Paybox, always with the secret key. Never sends card numbers:
// cards become tokens in the browser with the publishable key.

/** Paybox's catalogue id for the one price (PAYBOX.md): 1200 per seat per 30 days. */
export const SEAT_PRICE = 'price_seat_monthly';

export interface PayboxPayment {
  status: 'succeeded' | 'failed' | 'requires_action' | string;
  next_action?: { type: string; url: string } | null;
  error?: { code: string } | null;
}

export interface PayboxSubscription {
  id: string;
  customer: string;
  status: 'incomplete' | 'incomplete_expired' | 'active' | 'past_due' | 'canceled' | string;
  quantity: number;
  cancel_at_period_end: boolean;
  current_period_end: number;
  latest_invoice: { id: string; status: string; next_payment_attempt: number | null; payment: PayboxPayment | null } | null;
}

export interface PayboxCustomer {
  id: string;
  metadata: Record<string, string>;
}

export type PayboxResult<T> = { ok: true; status: number; body: T } | { ok: false; status: number; code: string; message: string };

export class PayboxUnavailable extends Error {}

/**
 * One call. POSTs carry an Idempotency-Key, so a retry after a timeout or a
 * 5xx (with the same key) cannot create a second customer or subscription
 * or charge twice; Paybox replays the original answer instead.
 */
export async function paybox<T>(method: 'GET' | 'POST' | 'DELETE', path: string, opts: { body?: unknown; idempotencyKey?: string; timeoutMs?: number; attempts?: number } = {}): Promise<PayboxResult<T>> {
  if (method === 'POST' && !opts.idempotencyKey) throw new Error(`POST ${path} needs an Idempotency-Key`);
  let lastError = 'no attempt';
  const attempts = opts.attempts ?? 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(`${config.paybox.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${config.paybox.secretKey}`,
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
      });
      const body = (await res.json().catch(() => ({}))) as T & { error?: { code?: string; message?: string } };
      if (res.status >= 500) {
        lastError = `HTTP ${res.status}`;
      } else if (res.ok) {
        return { ok: true, status: res.status, body };
      } else {
        return { ok: false, status: res.status, code: body.error?.code ?? `http_${res.status}`, message: body.error?.message ?? '' };
      }
    } catch (err) {
      lastError = (err as Error).message;
    }
    if (attempt < attempts) await new Promise((r) => setTimeout(r, 200 * attempt));
  }
  throw new PayboxUnavailable(`Paybox ${method} ${path} failed: ${lastError}`);
}
