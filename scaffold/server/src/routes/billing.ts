import express, { Router } from 'express';
import { requireJsonForWrites, requireMember, requireSession, workspaceOf } from '../auth/middleware.js';
import type { Membership } from '../auth/oidc.js';
import { PayboxUnavailable } from '../billing/paybox.js';
import { browserPaybox, changeSeats, currentBilling, describe, handlePayboxEvent, subscribe, type BillingOutcome } from '../billing/service.js';
import { config } from '../config.js';
import { HttpError, requireString, wrap } from '../errors.js';
import { verifySignature } from '../webhooks/signature.js';
import { requireGraderToken } from './grader.js';

const answer = (res: express.Response, out: BillingOutcome) => res.status(out.ok ? 200 : 402).json({ ...out.billing, ...(out.error ? { error: out.error } : {}) });

/**
 * POST /webhooks/paybox. Signed exactly like Pigeon (x-paybox-signature).
 * Anyone can post here, so an unsigned "payment succeeded" is 401, and even a
 * signed event only makes us re-read the subscription from Paybox.
 */
export function payboxWebhookRouter(): Router {
  const r = Router();
  r.post(
    '/',
    express.raw({ type: () => true, limit: '1mb' }),
    wrap(async (req, res) => {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const check = verifySignature({ header: req.get('x-paybox-signature'), rawBody, secret: config.paybox.webhookSecret });
      if (!check.ok) {
        res.status(401).json({ error: `signature ${check.reason}` });
        return;
      }
      let event: unknown;
      try {
        event = JSON.parse(rawBody.toString('utf8'));
      } catch {
        res.status(400).json({ error: 'body is not JSON' });
        return;
      }
      if (typeof event !== 'object' || event === null || Array.isArray(event)) {
        res.status(400).json({ error: 'event must be an object' });
        return;
      }
      try {
        res.status(200).json({ ok: true, result: await handlePayboxEvent(event as Record<string, unknown>) });
      } catch (err) {
        if (!(err instanceof PayboxUnavailable)) throw err;
        res.status(503).json({ error: 'Paybox did not answer; send it again' }); // Paybox retries
      }
    }),
  );
  return r;
}

/** POST /__grader/billing/subscribe and /seats: what the admin's form does, for the check. */
export function billingGraderRouter(): Router {
  const r = Router();
  r.use(requireGraderToken);
  r.use(express.json({ limit: '16kb' }));
  r.post(
    '/subscribe',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      answer(res, await subscribe(requireString(body, 'workspace'), body.seats, body.token));
    }),
  );
  r.post(
    '/seats',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      answer(res, await changeSeats(requireString(body, 'workspace'), body.seats));
    }),
  );
  return r;
}

/**
 * /api/billing?workspace=<id>, for admins of that workspace only (403 for
 * agents). The card form tokenises in the browser with the publishable key;
 * this server only ever sees the token.
 *
 *   GET  /api/billing?workspace=            state in plain words + Paybox's publishable key
 *   POST /api/billing/subscribe?workspace=  { seats, token } -> 200 active | 402 not active
 *   POST /api/billing/seats?workspace=      { seats }        -> 200 changed | 402 not changed
 */
export function billingApiRouter(): Router {
  const r = Router();
  r.use(requireSession, requireMember, (_req, res, next) => {
    if ((res.locals.membership as Membership).role !== 'admin') return next(new HttpError(403, 'only workspace admins can see or change billing'));
    next();
  });
  r.use(requireJsonForWrites);
  r.use(express.json({ limit: '16kb' }));

  r.get(
    '/',
    wrap(async (_req, res) => {
      const ws = workspaceOf(res);
      res.json({ ...describe(ws, await currentBilling(ws)), paybox: browserPaybox() });
    }),
  );
  r.post(
    '/subscribe',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      answer(res, await subscribe(workspaceOf(res), body.seats, body.token));
    }),
  );
  r.post(
    '/seats',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      answer(res, await changeSeats(workspaceOf(res), body.seats));
    }),
  );
  return r;
}
