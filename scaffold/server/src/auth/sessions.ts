import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { getRedis, SESSION_PREFIX } from '../redis.js';
import { randomToken, type Identity } from './oidc.js';

// Login state and sessions live in Redis, so any instance can finish a login
// another instance started, and any instance can serve a signed-in user.
// Keys hold a SHA-256 of the secret, never the secret itself: reading Redis
// does not give you a usable cookie. They sit under SESSION_PREFIX, which
// POST /__grader/reset leaves alone.

export const SESSION_COOKIE = 'sb_session';
export const LOGIN_COOKIE = 'sb_login';

const digest = (secret: string) => createHash('sha256').update(secret).digest('base64url');
const sessionKey = (id: string) => `${SESSION_PREFIX}s:${digest(id)}`;
const loginKey = (state: string) => `${SESSION_PREFIX}login:${digest(state)}`;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,128}$/;

export interface Session extends Identity {
  createdAt: string;
}

export interface PendingLogin {
  verifier: string;
  nonce: string;
}

export async function savePendingLogin(state: string, pending: PendingLogin): Promise<void> {
  await getRedis().set(loginKey(state), JSON.stringify(pending), 'EX', config.session.loginStateTtlSeconds);
}

/** Single use: GETDEL, so a replayed callback finds nothing. */
export async function takePendingLogin(state: string): Promise<PendingLogin | null> {
  if (!TOKEN_SHAPE.test(state)) return null;
  const raw = await getRedis().getdel(loginKey(state));
  return raw ? (JSON.parse(raw) as PendingLogin) : null;
}

/** A fresh random id on every login, so a session id can never be planted in advance. */
export async function createSession(identity: Identity): Promise<string> {
  const id = randomToken();
  const session: Session = { ...identity, createdAt: new Date().toISOString() };
  await getRedis().set(sessionKey(id), JSON.stringify(session), 'EX', config.session.ttlSeconds);
  return id;
}

export async function getSession(id: string | undefined): Promise<Session | null> {
  if (!id || !TOKEN_SHAPE.test(id)) return null;
  const raw = await getRedis().get(sessionKey(id));
  return raw ? (JSON.parse(raw) as Session) : null;
}

export async function deleteSession(id: string | undefined): Promise<void> {
  if (id && TOKEN_SHAPE.test(id)) await getRedis().del(sessionKey(id));
}
