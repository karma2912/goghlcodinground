import { createHash, timingSafeEqual } from 'node:crypto';
import express, { Router, type RequestHandler } from 'express';
import { config } from '../config.js';
import { requireString, wrap } from '../errors.js';
import { claimConversation } from '../services/conversations.js';
import { createReply } from '../services/replies.js';
import { resetAll } from '../services/reset.js';
import { buildSnapshot } from '../services/snapshot.js';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();

/** Constant-time comparison; hashing first makes the lengths equal. */
export function tokenMatches(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || given === '' || expected === '') return false;
  return timingSafeEqual(sha256(given), sha256(expected));
}

export const requireGraderToken: RequestHandler = (req, res, next) => {
  if (!tokenMatches(req.get('x-grader-token'), config.graderToken)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
};

/**
 * The check's endpoints. Thin wrappers: each calls the same service the UI
 * calls, so the check exercises the real code paths.
 */
export function graderRouter(): Router {
  const r = Router();
  r.use(requireGraderToken);
  r.use(express.json({ limit: '100kb' }));

  r.post('/reset', wrap(async (_req, res) => {
    await resetAll();
    res.status(200).json({ ok: true });
  }));

  r.get('/snapshot', wrap(async (_req, res) => {
    res.status(200).json(await buildSnapshot());
  }));

  r.post('/reply', wrap(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const workspace = requireString(body, 'workspace');
    const contact = requireString(body, 'contact');
    const text = requireString(body, 'text');
    const clientRef = requireString(body, 'client_ref');
    const { created } = await createReply({ workspace, contact, text, clientRef, author: 'grader' });
    res.status(202).json({ client_ref: clientRef, status: 'queued', created });
  }));

  r.post('/claim', wrap(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const workspace = requireString(body, 'workspace');
    const contact = requireString(body, 'contact');
    const agent = requireString(body, 'agent');
    const result = await claimConversation(workspace, contact, agent);
    res.status(result.ok ? 200 : 409).json({ assignee: result.assignee });
  }));

  return r;
}
