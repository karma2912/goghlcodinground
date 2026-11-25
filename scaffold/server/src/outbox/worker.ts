import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { WithId } from 'mongodb';
import { config } from '../config.js';
import { messages, type MessageDoc } from '../db.js';
import { replaceableBy } from '../services/status.js';
import { sendToPigeon, type SendOutcome } from './pigeonClient.js';
import { startCoolOff, takeSendToken } from './rateLimit.js';
import { onOutboxNudge } from './signal.js';
import { publishBestEffort } from '../realtime/events.js';

/** Exponential backoff with ±20 % jitter: base, 2×base, 4×base ... capped. */
export function backoffMs(attempts: number, baseMs: number, maxMs: number, random = Math.random): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempts - 1));
  return Math.round(exp * (0.8 + 0.4 * random()));
}

export interface WorkerOptions {
  leaseMs: number;
  pollMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  concurrency: number;
  send: typeof sendToPigeon;
  log: (msg: string) => void;
}

type Job = WithId<MessageDoc> & { leaseToken: string };

/**
 * Sends queued replies to Pigeon. Every instance runs one; they coordinate
 * only through MongoDB (leases) and Redis (rate limit), never in memory.
 */
export class OutboxWorker {
  readonly id = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private readonly opts: WorkerOptions;
  private timer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private ticking = false;
  private again = false;
  private inFlight = 0;
  private stopped = true;

  constructor(opts: Partial<WorkerOptions> = {}) {
    this.opts = {
      leaseMs: config.outbox.leaseMs,
      pollMs: config.outbox.pollMs,
      backoffBaseMs: config.outbox.backoffBaseMs,
      backoffMaxMs: config.outbox.backoffMaxMs,
      concurrency: 8,
      send: sendToPigeon,
      log: (m) => console.log(`[outbox] ${m}`),
      ...opts,
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => this.tick(), this.opts.pollMs);
    this.unsubscribe = onOutboxNudge(() => this.tick());
    this.tick();
  }

  /** Stops taking new work; resolves when in-flight sends have finished. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.unsubscribe?.();
    while (this.inFlight > 0 || this.ticking) await new Promise((r) => setTimeout(r, 20));
  }

  /** Lease and start as many due replies as there are free slots. */
  tick(): void {
    if (this.stopped) return;
    if (this.ticking) {
      this.again = true; // a nudge during a tick: run once more afterwards
      return;
    }
    this.ticking = true;
    void (async () => {
      try {
        do {
          this.again = false;
          while (!this.stopped && this.inFlight < this.opts.concurrency) {
            const job = await this.lease();
            if (!job) break;
            this.inFlight++;
            void this.process(job)
              .catch((err) => this.opts.log(`send ${job.clientRef} crashed: ${(err as Error).message}`))
              .finally(() => {
                this.inFlight--;
                this.tick();
              });
          }
        } while (this.again && !this.stopped);
      } catch (err) {
        this.opts.log(`lease failed: ${(err as Error).message}`); // Mongo down: next poll retries
      } finally {
        this.ticking = false;
      }
    })();
  }

  /**
   * Take one due reply. Atomic in MongoDB: the filter only matches a reply
   * whose lease is free or expired, and the same update sets a new lease, so
   * two workers can never both get it.
   */
  async lease(now = new Date()): Promise<Job | null> {
    const leaseToken = randomUUID();
    const doc = await (await messages()).findOneAndUpdate(
      {
        sendState: 'pending',
        nextAttemptAt: { $lte: now },
        $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
      },
      { $set: { lockedUntil: new Date(now.getTime() + this.opts.leaseMs), leaseToken } },
      { sort: { nextAttemptAt: 1 }, returnDocument: 'after' },
    );
    return doc ? ({ ...doc, leaseToken } as Job) : null;
  }

  private async process(job: Job): Promise<void> {
    const col = await messages();
    const mine = { _id: job._id, leaseToken: job.leaseToken };

    // Shared per-workspace limit: wait our turn without making a request.
    const waitMs = await takeSendToken(job.workspace);
    if (waitMs > 0) {
      await col.updateOne(mine, { $set: { lockedUntil: null, leaseToken: null, nextAttemptAt: new Date(Date.now() + waitMs) } });
      return;
    }

    await col.updateOne(mine, { $inc: { attempts: 1 } });
    const outcome: SendOutcome = await this.opts.send({ workspace: job.workspace, to: job.contact, text: job.text, clientRef: job.clientRef! });
    const attempts = (job.attempts ?? 0) + 1;

    switch (outcome.kind) {
      case 'accepted':
        // A fact about Pigeon, true whoever holds the lease now: no lease check.
        await col.updateOne(
          { _id: job._id, sendState: 'pending' },
          { $set: { sendState: 'accepted', acceptedAt: new Date(), pigeonId: outcome.pigeonId, lockedUntil: null, leaseToken: null, lastError: null } },
        );
        return;

      case 'rate_limited': {
        const ms = outcome.retryAfterMs + 250; // margin: our clock and Pigeon's differ
        await startCoolOff(job.workspace, ms);
        await col.updateOne(mine, { $set: { lockedUntil: null, leaseToken: null, nextAttemptAt: new Date(Date.now() + ms), lastError: 'HTTP 429' } });
        return;
      }

      case 'retry': {
        const ms = backoffMs(attempts, this.opts.backoffBaseMs, this.opts.backoffMaxMs);
        this.opts.log(`${job.clientRef} attempt ${attempts}: ${outcome.reason}; retry in ${ms} ms`);
        await col.updateOne(mine, { $set: { lockedUntil: null, leaseToken: null, nextAttemptAt: new Date(Date.now() + ms), lastError: outcome.reason } });
        return;
      }

      case 'rejected':
        this.opts.log(`${job.clientRef} rejected by Pigeon: ${outcome.reason}; marked failed`);
        await col.updateOne(mine, { $set: { sendState: 'rejected', lockedUntil: null, leaseToken: null, lastError: outcome.reason } });
        const failed = await col.updateOne({ _id: job._id, status: { $in: replaceableBy('failed') } }, { $set: { status: 'failed' } });
        if (failed.modifiedCount > 0) publishBestEffort(job.workspace, { type: 'message.status', contact: job.contact, client_ref: job.clientRef!, status: 'failed' });
        return;
    }
  }
}
