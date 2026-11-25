import express, { Router } from 'express';
import { requireJsonForWrites, requireMember, requireSession, sessionOf, workspaceOf } from '../auth/middleware.js';
import { HttpError, requireString, wrap } from '../errors.js';
import { claimConversation } from '../services/conversations.js';
import { getConversation, listConversations, setConversationStatus } from '../services/inbox.js';
import { createReply } from '../services/replies.js';

const MAX_TEXT = 4000;

/**
 * The agent API, used by the React app and by level 5 of the check.
 * Every route needs a session (401); every /conversations route needs
 * ?workspace=<id> naming one of the user's workspaces (403 otherwise).
 *
 *   GET  /api/me
 *   GET  /api/conversations?workspace=&limit=&cursor=&status=open|closed
 *   GET  /api/conversations/:contact?workspace=              conversation + messages
 *   POST /api/conversations/:contact/reply?workspace=        { text, client_ref } -> 202
 *   POST /api/conversations/:contact/claim?workspace=        200 | 409
 *   POST /api/conversations/:contact/close?workspace=
 *   POST /api/conversations/:contact/reopen?workspace=
 */
export function apiRouter(): Router {
  const r = Router();
  r.use(requireSession);
  r.use(requireJsonForWrites);
  r.use(express.json({ limit: '32kb' }));

  r.get('/me', (_req, res) => {
    const s = sessionOf(res);
    res.json({ sub: s.sub, name: s.name, email: s.email, workspaces: s.workspaces.map((w) => ({ id: w.id, role: w.role })) });
  });

  const conv = Router({ mergeParams: true });
  r.use('/conversations', requireMember, conv);

  conv.get(
    '/',
    wrap(async (req, res) => {
      const { limit, cursor, status } = req.query;
      if (status !== undefined && status !== 'open' && status !== 'closed') throw new HttpError(400, 'status must be open or closed');
      if (cursor !== undefined && typeof cursor !== 'string') throw new HttpError(400, 'invalid cursor');
      res.json(await listConversations(workspaceOf(res), { limit: limit === undefined ? undefined : Number(limit) || 25, cursor, status }));
    }),
  );

  conv.get(
    '/:contact',
    wrap(async (req, res) => {
      res.json(await getConversation(workspaceOf(res), req.params.contact));
    }),
  );

  conv.post(
    '/:contact/reply',
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const text = requireString(body, 'text');
      // The browser makes the client_ref, so a retried request is the same reply.
      const clientRef = requireString(body, 'client_ref');
      if (text.length > MAX_TEXT) throw new HttpError(400, `text is longer than ${MAX_TEXT} characters`);
      if (clientRef.length > 128) throw new HttpError(400, 'client_ref is too long');
      const { created } = await createReply({ workspace: workspaceOf(res), contact: req.params.contact, text, clientRef, author: sessionOf(res).sub });
      res.status(202).json({ client_ref: clientRef, status: 'queued', created });
    }),
  );

  conv.post(
    '/:contact/claim',
    wrap(async (req, res) => {
      const result = await claimConversation(workspaceOf(res), req.params.contact, sessionOf(res).sub);
      res.status(result.ok ? 200 : 409).json({ assignee: result.assignee });
    }),
  );

  for (const [action, status] of [['close', 'closed'], ['reopen', 'open']] as const) {
    conv.post(
      `/:contact/${action}`,
      wrap(async (req, res) => {
        res.json(await setConversationStatus(workspaceOf(res), req.params.contact, status));
      }),
    );
  }

  return r;
}
