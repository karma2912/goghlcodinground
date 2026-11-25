import express, { Router } from 'express';
import { config, workspaceExists } from '../config.js';
import { wrap } from '../errors.js';
import { recordInbound } from '../services/inbound.js';
import { applyStatus, isOutboundStatus } from '../services/status.js';
import type { OutboundStatus } from '../db.js';
import { verifySignature } from '../webhooks/signature.js';

type Parsed =
  | { kind: 'inbound'; workspace: string; contact: string; messageId: string; text: string; occurredAt: Date }
  | { kind: 'status'; workspace: string; clientRef: string | null; pigeonId: string | null; status: OutboundStatus }
  | { kind: 'ignore'; why: string }
  | { kind: 'invalid'; why: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Turn a verified raw body into what we do with it. Never throws. */
export function parsePigeonEvent(raw: Buffer): Parsed {
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return { kind: 'invalid', why: 'body is not JSON' };
  }
  if (!isObject(body) || !nonEmpty(body.type)) return { kind: 'invalid', why: 'no event type' };

  // Pigeon adds event types without notice: acknowledge and ignore.
  if (body.type !== 'message.inbound' && body.type !== 'message.status') return { kind: 'ignore', why: `event type ${body.type} not handled` };

  if (!nonEmpty(body.workspace)) return { kind: 'invalid', why: 'no workspace' };
  if (!workspaceExists(body.workspace)) return { kind: 'ignore', why: `unknown workspace ${body.workspace}` };

  const data = body.data;
  if (body.type === 'message.status') {
    if (!isObject(data) || !nonEmpty(data.status)) return { kind: 'invalid', why: 'data.status is required' };
    const clientRef = nonEmpty(data.client_ref) ? data.client_ref : null;
    const pigeonId = nonEmpty(data.message_id) ? data.message_id : null;
    if (!clientRef && !pigeonId) return { kind: 'invalid', why: 'data.client_ref or data.message_id is required' };
    // a status value we do not know yet: acknowledge, keep what we have
    if (!isOutboundStatus(data.status) || data.status === 'queued') return { kind: 'ignore', why: `status ${data.status} not handled` };
    return { kind: 'status', workspace: body.workspace, clientRef, pigeonId, status: data.status };
  }

  if (!isObject(data) || !nonEmpty(data.message_id) || !nonEmpty(data.from) || typeof data.text !== 'string') {
    return { kind: 'invalid', why: 'data.message_id, data.from and data.text are required' };
  }
  const occurredAt = typeof body.occurred_at === 'string' ? new Date(body.occurred_at) : new Date(NaN);
  if (Number.isNaN(occurredAt.getTime())) return { kind: 'invalid', why: 'occurred_at is not a date' };

  return { kind: 'inbound', workspace: body.workspace, contact: data.from, messageId: data.message_id, text: data.text, occurredAt };
}

/**
 * POST /webhooks/pigeon. Answers, per PIGEON.md:
 *   bad/missing signature, or timestamp > 5 min away   401
 *   verified but unparseable                           400
 *   unknown type / unknown workspace                   200, ignored
 *   status for a message we never sent                 200, ignored
 *   inbound message stored (or already stored)         200
 *   status applied (forward only, or already newer)    200
 */
export function webhookRouter(): Router {
  const r = Router();

  r.post(
    '/pigeon',
    // Raw bytes for every content type: the HMAC covers the body exactly as sent.
    express.raw({ type: () => true, limit: '1mb' }),
    wrap(async (req, res) => {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const check = verifySignature({ header: req.get('x-pigeon-signature'), rawBody, secret: config.pigeon.webhookSecret });
      if (!check.ok) {
        res.status(401).json({ error: `signature ${check.reason}` });
        return;
      }

      const event = parsePigeonEvent(rawBody);
      if (event.kind === 'invalid') {
        res.status(400).json({ error: event.why });
        return;
      }
      if (event.kind === 'ignore') {
        res.status(200).json({ ok: true, ignored: event.why });
        return;
      }
      if (event.kind === 'status') {
        const result = await applyStatus(event);
        res.status(200).json({ ok: true, status: result });
        return;
      }

      const { created } = await recordInbound({ ...event, eventId: req.get('x-pigeon-event-id') ?? null });
      res.status(200).json({ ok: true, duplicate: !created });
    }),
  );

  return r;
}
