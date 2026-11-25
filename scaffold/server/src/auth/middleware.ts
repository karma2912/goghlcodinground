import type { Request, RequestHandler, Response } from 'express';
import { HttpError } from '../errors.js';
import { parseCookies } from './cookies.js';
import type { Membership } from './oidc.js';
import { getSession, SESSION_COOKIE, type Session } from './sessions.js';

/** The signed-in user, from the session cookie, or null. Used by the API and the WebSocket. */
export async function sessionFromCookieHeader(cookieHeader: string | undefined): Promise<Session | null> {
  return getSession(parseCookies(cookieHeader)[SESSION_COOKIE]);
}

/** 401 without a valid session; otherwise res.locals.session is set. */
export const requireSession: RequestHandler = (req, res, next) => {
  sessionFromCookieHeader(req.headers.cookie).then((session) => {
    if (!session) return next(new HttpError(401, 'not signed in'));
    res.locals.session = session;
    next();
  }, next);
};

export function sessionOf(res: Response): Session {
  return res.locals.session as Session;
}

/** The membership for a workspace, or null when the user is not in it. */
export function membership(session: Session, workspace: unknown): Membership | null {
  if (typeof workspace !== 'string') return null;
  return session.workspaces.find((w) => w.id === workspace) ?? null;
}

/**
 * Runs after requireSession. `?workspace=` must name a workspace the user is
 * a member of: 400 when missing, 403 when not a member.
 */
export const requireMember: RequestHandler = (req, res, next) => {
  const workspace = req.query.workspace;
  if (typeof workspace !== 'string' || workspace === '') return next(new HttpError(400, 'workspace query parameter is required'));
  const m = membership(sessionOf(res), workspace);
  if (!m) return next(new HttpError(403, 'not a member of this workspace'));
  res.locals.membership = m;
  next();
};

export function workspaceOf(res: Response): string {
  return (res.locals.membership as Membership).id;
}

/**
 * State-changing requests must be JSON. A cross-site HTML form cannot send
 * application/json without a CORS preflight we never allow, so together with
 * the SameSite=Lax cookie this blocks cross-site request forgery.
 */
export const requireJsonForWrites: RequestHandler = (req: Request, _res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (!req.is('application/json')) return next(new HttpError(415, 'requests that change something must be application/json'));
  next();
};
