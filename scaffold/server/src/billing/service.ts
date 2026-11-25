import { randomUUID } from 'node:crypto';
import type { Collection } from 'mongodb';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { HttpError } from '../errors.js';
import { APP_PREFIX, getRedis } from '../redis.js';
import { assertWorkspace } from '../services/conversations.js';
import { paybox, PayboxUnavailable, SEAT_PRICE, type PayboxCustomer, type PayboxSubscription } from './paybox.js';

// Per-seat subscriptions through Paybox. Rules (also in DECISIONS.md):
//   none        never subscribed (or the first payment never completed): free trial, can send
//   incomplete  first payment failed or awaits the bank: still the trial, can send
//   active      paid: can send
//   past_due    a renewal failed, Paybox is retrying (3 and 5 days): grace, can send
//   canceled    Paybox gave up, or it was canceled: cannot send, can still read
//
// Paybox is the source of truth. Webhooks are only a hint that something
// changed: we then read the subscription's present state from Paybox. The
// snapshot and the reply gate read it too, so a clock jump or a late webhook
// never leaves a stale answer.

export type BillingStatus = 'none' | 'incomplete' | 'active' | 'past_due' | 'canceled';

export interface BillingDoc {
  workspace: string;
  customerId: string | null;
  subscriptionId: string | null;
  status: BillingStatus;
  seats: number;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
  nextPaymentAttempt: Date | null;
  payment: { status: string; nextActionUrl: string | null; errorCode: string | null } | null;
  seatChanges: number; // numbers each seat change, for its Idempotency-Key
  syncedAt: Date | null; // when the Paybox state we hold was read
}

export const canSend = (status: BillingStatus) => status !== 'canceled';

export function mapStatus(paybox: string): BillingStatus {
  if (paybox === 'active' || paybox === 'past_due' || paybox === 'canceled' || paybox === 'incomplete') return paybox;
  return 'none'; // incomplete_expired: the first payment never happened, back to the trial
}

// ---------------------------------------------------------------- storage

let indexed: Promise<void> | undefined;
async function billing(): Promise<Collection<BillingDoc>> {
  const col = (await getDb()).collection<BillingDoc>('billing');
  indexed ??= col.createIndex({ workspace: 1 }, { unique: true }).then(
    () => undefined,
    (err) => {
      indexed = undefined;
      throw err;
    },
  );
  await indexed;
  return col;
}

function fromSubscription(sub: PayboxSubscription) {
  const pay = sub.latest_invoice?.payment ?? null;
  return {
    status: mapStatus(sub.status),
    seats: sub.quantity,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
    nextPaymentAttempt: sub.latest_invoice?.next_payment_attempt ? new Date(sub.latest_invoice.next_payment_attempt * 1000) : null,
    payment: pay ? { status: pay.status, nextActionUrl: pay.next_action?.url ?? null, errorCode: pay.error?.code ?? null } : null,
  };
}

/**
 * Store Paybox's state of our current subscription, unless a newer read is
 * already stored (two webhooks can race; the later read wins). Late news
 * about a subscription we have replaced is ignored.
 */
async function applySubscription(workspace: string, sub: PayboxSubscription, readAt: Date): Promise<void> {
  await (await billing()).updateOne(
    { workspace, subscriptionId: sub.id, $or: [{ syncedAt: null }, { syncedAt: { $lt: readAt } }] },
    { $set: { ...fromSubscription(sub), syncedAt: readAt } },
  );
}

/** Read Paybox's present state for one subscription and store it. */
async function sync(workspace: string, subscriptionId: string, attempts: number): Promise<void> {
  const readAt = new Date();
  const r = await paybox<PayboxSubscription>('GET', `/v1/subscriptions/${subscriptionId}`, { attempts, timeoutMs: 2000 });
  if (r.ok) await applySubscription(workspace, r.body, readAt);
}

/**
 * The workspace's billing as of now. With a subscription, Paybox is asked
 * first (one quick try); if it does not answer, the last stored state is used.
 * Without one (the trial), Paybox is never called.
 */
export async function currentBilling(workspace: string): Promise<BillingDoc | null> {
  const col = await billing();
  const doc = await col.findOne({ workspace }, { projection: { _id: 0 } });
  if (!doc?.subscriptionId) return doc;
  try {
    await sync(workspace, doc.subscriptionId, 1);
  } catch (err) {
    if (!(err instanceof PayboxUnavailable)) throw err;
    console.error('billing: using stored state:', err.message);
  }
  return col.findOne({ workspace }, { projection: { _id: 0 } });
}

// ------------------------------------------------------------------ lock

/**
 * One billing change per workspace at a time, across all instances. This is
 * what turns "subscribe three times in the same instant" into one customer
 * and one subscription: the second and third wait, then find it active.
 */
async function withWorkspaceLock<T>(workspace: string, fn: () => Promise<T>): Promise<T> {
  const key = `${APP_PREFIX}billing:lock:${workspace}`;
  const token = randomUUID();
  const r = getRedis();
  const until = Date.now() + 25_000;
  while ((await r.set(key, token, 'PX', 30_000, 'NX')) !== 'OK') {
    if (Date.now() > until) throw new HttpError(503, 'billing is busy for this workspace, try again');
    await new Promise((res) => setTimeout(res, 50 + Math.random() * 50));
  }
  try {
    return await fn();
  } finally {
    // release only our own lock
    await r.eval(`if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`, 1, key, token).catch(() => undefined);
  }
}

// ---------------------------------------------------------------- actions

export interface BillingOutcome {
  ok: boolean; // the subscription is active (subscribe) / the seats changed (seats)
  billing: BillingView;
  error?: string;
}

function validSeats(seats: unknown): number {
  if (!Number.isInteger(seats) || (seats as number) < 1 || (seats as number) > 10_000) throw new HttpError(400, 'seats must be a whole number from 1 to 10000');
  return seats as number;
}

async function ensureCustomer(workspace: string, existing: string | null): Promise<string> {
  if (existing) return existing;
  // Deterministic key: however often this runs, Paybox makes one customer.
  const r = await paybox<PayboxCustomer>('POST', '/v1/customers', { body: { name: workspace, metadata: { workspace } }, idempotencyKey: `sb-customer-${workspace}` });
  if (!r.ok) throw new HttpError(502, `Paybox refused to create the customer: ${r.code}`);
  await (await billing()).updateOne(
    { workspace },
    { $set: { customerId: r.body.id }, $setOnInsert: { subscriptionId: null, status: 'none', seats: 0, cancelAtPeriodEnd: false, currentPeriodEnd: null, nextPaymentAttempt: null, payment: null, seatChanges: 0, syncedAt: null } },
    { upsert: true },
  );
  return r.body.id;
}

/** Attach the card the browser tokenised. A token works once; its key makes our retries safe. */
async function attachCard(workspace: string, customerId: string, token: string) {
  return paybox('POST', `/v1/customers/${customerId}/payment_method`, { body: { token }, idempotencyKey: `sb-card-${workspace}-${token}` });
}

/** What the admin's form does: subscribe the workspace for `seats` with a card token. */
export async function subscribe(workspace: string, seatsIn: unknown, token: unknown): Promise<BillingOutcome> {
  assertWorkspace(workspace);
  const seats = validSeats(seatsIn);
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(token)) throw new HttpError(400, 'token must be a Paybox card token');

  return withWorkspaceLock(workspace, async () => {
    const before = await currentBilling(workspace);
    if (before?.status === 'active') return { ok: true, billing: describe(workspace, before) }; // already paid for

    let customerId = await ensureCustomer(workspace, before?.customerId ?? null);
    let card = await attachCard(workspace, customerId, token);
    if (!card.ok && card.code === 'no_such_customer') {
      // Paybox forgot the customer (it was reset): make a new one.
      await (await billing()).updateOne({ workspace }, { $set: { customerId: null } });
      customerId = await ensureCustomer(workspace, null);
      card = await attachCard(workspace, customerId, token);
    }
    if (!card.ok) return { ok: false, billing: describe(workspace, await currentBilling(workspace)), error: card.code };

    if (before?.status === 'past_due') {
      // The new card is used by Paybox's next scheduled retry.
      return { ok: false, billing: describe(workspace, await currentBilling(workspace)), error: 'past_due' };
    }

    // Never leave two live subscriptions: drop an unpaid one before starting again.
    if (before?.subscriptionId && before.status === 'incomplete') {
      await paybox('DELETE', `/v1/subscriptions/${before.subscriptionId}`).catch(() => undefined);
    }

    const readAt = new Date();
    const r = await paybox<PayboxSubscription>('POST', '/v1/subscriptions', {
      body: { customer: customerId, price: SEAT_PRICE, quantity: seats, metadata: { workspace } },
      idempotencyKey: `sb-sub-${workspace}-${token}`,
    });
    if (!r.ok) return { ok: false, billing: describe(workspace, await currentBilling(workspace)), error: r.code };

    await (await billing()).updateOne({ workspace }, { $set: { subscriptionId: r.body.id, seatChanges: 0, ...fromSubscription(r.body), syncedAt: readAt } });
    const after = await (await billing()).findOne({ workspace }, { projection: { _id: 0 } });
    return { ok: after?.status === 'active', billing: describe(workspace, after) };
  });
}

/** Change the number of seats. Increases are charged now, all or nothing (Paybox answers 402). */
export async function changeSeats(workspace: string, seatsIn: unknown): Promise<BillingOutcome> {
  assertWorkspace(workspace);
  const seats = validSeats(seatsIn);

  return withWorkspaceLock(workspace, async () => {
    const before = await currentBilling(workspace);
    if (!before?.subscriptionId || (before.status !== 'active' && before.status !== 'past_due')) {
      return { ok: false, billing: describe(workspace, before), error: 'no_active_subscription' };
    }
    if (before.seats === seats) return { ok: true, billing: describe(workspace, before) };

    // A new key per change (3 -> 5 -> 3 -> 5 are four changes), reused only by retries of this one.
    const n = (before.seatChanges ?? 0) + 1;
    await (await billing()).updateOne({ workspace }, { $set: { seatChanges: n } });
    const readAt = new Date();
    const r = await paybox<PayboxSubscription>('POST', `/v1/subscriptions/${before.subscriptionId}`, {
      body: { quantity: seats },
      idempotencyKey: `sb-seats-${before.subscriptionId}-${n}`,
    });
    if (!r.ok) return { ok: false, billing: describe(workspace, await currentBilling(workspace)), error: r.code };
    await applySubscription(workspace, r.body, readAt);
    return { ok: true, billing: describe(workspace, await (await billing()).findOne({ workspace }, { projection: { _id: 0 } })) };
  });
}

/** The reply gate: a canceled workspace cannot send. */
export async function assertCanSend(workspace: string): Promise<void> {
  const doc = await currentBilling(workspace);
  if (doc && !canSend(doc.status)) throw new HttpError(402, 'the subscription for this workspace is canceled: subscribe again to send messages');
}

/** For GET /__grader/snapshot. */
export async function billingSnapshot(workspace: string): Promise<{ status: BillingStatus; seats: number; can_send: boolean }> {
  const doc = await currentBilling(workspace);
  const status = doc?.status ?? 'none';
  return { status, seats: doc?.seats ?? 0, can_send: canSend(status) };
}

// ------------------------------------------------------------- webhooks

const EVENT_TYPES = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.payment_action_required',
]);

/**
 * A verified Paybox event. The object inside is a photograph of the past and
 * events arrive in any order, so we only take the subscription id from it and
 * read the present state. Events about subscriptions we do not hold are ignored.
 */
export async function handlePayboxEvent(event: Record<string, unknown>): Promise<'applied' | 'ignored'> {
  if (typeof event.type !== 'string' || !EVENT_TYPES.has(event.type)) return 'ignored';
  const object = (event.data as { object?: Record<string, unknown> } | undefined)?.object;
  if (!object || typeof object !== 'object') throw new HttpError(400, 'event has no data.object');
  const subscriptionId = event.type.startsWith('invoice.') ? object.subscription : object.id;
  if (typeof subscriptionId !== 'string') return 'ignored';

  const doc = await (await billing()).findOne({ subscriptionId });
  if (!doc) return 'ignored';
  await sync(doc.workspace, subscriptionId, 2); // throws PayboxUnavailable: answer 5xx so Paybox retries
  return 'applied';
}

// ------------------------------------------------------- what the admin sees

export interface BillingView {
  status: BillingStatus;
  seats: number;
  can_send: boolean;
  cancel_at_period_end: boolean;
  current_period_end: string | null;
  next_payment_attempt: string | null;
  payment: { status: string; next_action_url: string | null; error: string | null } | null;
  message: string; // the state in plain words, and what to do about it
}

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : 'soon');

export function describe(_workspace: string, doc: BillingDoc | null): BillingView {
  const status = doc?.status ?? 'none';
  const seats = doc?.seats ?? 0;
  let message: string;
  switch (status) {
    case 'none':
      message = 'Free trial: your team can send messages. Subscribe to keep sending after the trial.';
      break;
    case 'incomplete':
      message =
        doc?.payment?.status === 'requires_action'
          ? 'Waiting for your bank to approve the first payment. Approve it at your bank to activate the subscription; until then you stay on the trial.'
          : `The first payment did not go through${doc?.payment?.errorCode ? ` (${doc.payment.errorCode.replace(/_/g, ' ')})` : ''}. Subscribe again with another card; until then you stay on the trial.`;
      break;
    case 'active':
      message = `Active: ${seats} seat${seats === 1 ? '' : 's'}, ${doc?.cancelAtPeriodEnd ? 'ends' : 'renews'} on ${day(doc?.currentPeriodEnd ?? null)}.`;
      break;
    case 'past_due':
      message = `A renewal payment failed. Paybox will try again on ${day(doc?.nextPaymentAttempt ?? null)}; add a working card before then or the subscription is canceled. Sending still works meanwhile.`;
      break;
    case 'canceled':
      message = 'Canceled: your team can still read the inbox but cannot send. Subscribe again to resume sending.';
      break;
  }
  return {
    status,
    seats,
    can_send: canSend(status),
    cancel_at_period_end: doc?.cancelAtPeriodEnd ?? false,
    current_period_end: doc?.currentPeriodEnd?.toISOString() ?? null,
    next_payment_attempt: doc?.nextPaymentAttempt?.toISOString() ?? null,
    payment: doc?.payment ? { status: doc.payment.status, next_action_url: doc.payment.nextActionUrl, error: doc.payment.errorCode } : null,
    message,
  };
}

/** What the browser needs to tokenise a card itself (publishable key only). */
export const browserPaybox = () => ({ url: config.paybox.url, publishable_key: config.paybox.publishableKey });
