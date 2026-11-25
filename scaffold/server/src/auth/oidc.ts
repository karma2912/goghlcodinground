import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey, type KeyObject } from 'node:crypto';
import { config } from '../config.js';

// OpenID Connect, authorization code flow with PKCE (S256), done by hand with
// node:crypto: discovery, the authorize URL, the code exchange, and full
// id_token verification (RS256 signature, iss, aud, exp, iat, nonce).

export type Role = 'admin' | 'agent';
export interface Membership {
  id: string;
  role: Role;
}
export interface Identity {
  sub: string;
  name: string | null;
  email: string | null;
  workspaces: Membership[];
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export class AuthError extends Error {}

const b64url = (buf: Buffer) => buf.toString('base64url');
export const randomToken = (bytes = 32) => b64url(randomBytes(bytes));
export const pkceChallenge = (verifier: string) => b64url(createHash('sha256').update(verifier).digest());

// ---------------------------------------------------------------- discovery

let discovery: Promise<Discovery> | undefined;

export function getDiscovery(): Promise<Discovery> {
  discovery ??= (async () => {
    const res = await fetch(`${config.oidc.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`OIDC discovery answered ${res.status}`);
    const d = (await res.json()) as Discovery;
    if (d.issuer !== config.oidc.issuer) throw new Error(`OIDC issuer mismatch: ${d.issuer}`);
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) if (typeof d[k] !== 'string') throw new Error(`OIDC discovery has no ${k}`);
    return d;
  })().catch((err) => {
    discovery = undefined; // try again on the next login
    throw err;
  });
  return discovery;
}

// --------------------------------------------------------------------- JWKS

let keys = new Map<string, KeyObject>();

async function refreshJwks(): Promise<void> {
  const res = await fetch((await getDiscovery()).jwks_uri, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`JWKS answered ${res.status}`);
  const { keys: list } = (await res.json()) as { keys: (JsonWebKey & { kid?: string })[] };
  const next = new Map<string, KeyObject>();
  for (const jwk of list ?? []) if (jwk.kid && jwk.kty === 'RSA') next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
  keys = next;
}

/** The signing key for `kid`; refetches once when unknown (the IdP rotated keys). */
async function keyFor(kid: string): Promise<KeyObject> {
  if (!keys.has(kid)) await refreshJwks();
  const key = keys.get(kid);
  if (!key) throw new AuthError(`unknown signing key ${kid}`);
  return key;
}

// --------------------------------------------------------------- the flow

export interface LoginStart {
  url: string;
  state: string;
  nonce: string;
  verifier: string;
}

export async function startLogin(): Promise<LoginStart> {
  const d = await getDiscovery();
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken(48); // 64 chars, within RFC 7636's 43..128
  const url = new URL(d.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.oidc.clientId,
    redirect_uri: config.oidc.redirectUri,
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
  }).toString();
  return { url: url.toString(), state, nonce, verifier };
}

/** Exchange the code (with the PKCE verifier) and return the verified identity. */
export async function finishLogin(code: string, verifier: string, nonce: string): Promise<Identity> {
  const d = await getDiscovery();
  const res = await fetch(d.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.oidc.redirectUri,
      client_id: config.oidc.clientId,
      client_secret: config.oidc.clientSecret,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(5000),
  });
  const body = (await res.json().catch(() => ({}))) as { id_token?: unknown; error?: unknown };
  if (!res.ok || typeof body.id_token !== 'string') throw new AuthError(`token exchange failed: ${res.status} ${String(body.error ?? '')}`);

  const header = decodeHeader(body.id_token);
  const key = await keyFor(header.kid);
  return verifyIdToken(body.id_token, { key, issuer: d.issuer, clientId: config.oidc.clientId, nonce });
}

// ------------------------------------------------------ id_token checking

function decodePart(part: string): Record<string, unknown> {
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v;
  } catch {
    /* fall through */
  }
  throw new AuthError('id_token is malformed');
}

export function decodeHeader(token: string): { alg: string; kid: string } {
  const h = decodePart(token.split('.')[0] ?? '');
  if (h.alg !== 'RS256') throw new AuthError(`id_token alg ${String(h.alg)} not accepted`);
  if (typeof h.kid !== 'string') throw new AuthError('id_token has no kid');
  return { alg: h.alg, kid: h.kid };
}

/**
 * Verify a compact JWS id_token. Pure given the key, so it is unit-tested.
 * Only RS256 is accepted (never "none", never HMAC with a public key).
 */
export function verifyIdToken(
  token: string,
  opts: { key: KeyObject; issuer: string; clientId: string; nonce: string; nowSeconds?: number; skewSeconds?: number },
): Identity {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('id_token is malformed');
  decodeHeader(token);
  const ok = verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), opts.key, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new AuthError('id_token signature is invalid');

  const c = decodePart(parts[1]);
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = opts.skewSeconds ?? 60;
  if (c.iss !== opts.issuer) throw new AuthError('id_token issuer mismatch');
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(opts.clientId)) throw new AuthError('id_token audience mismatch');
  if (typeof c.exp !== 'number' || c.exp + skew < now) throw new AuthError('id_token expired');
  if (typeof c.iat === 'number' && c.iat - skew > now) throw new AuthError('id_token issued in the future');
  if (c.nonce !== opts.nonce) throw new AuthError('id_token nonce mismatch');
  if (typeof c.sub !== 'string' || c.sub === '') throw new AuthError('id_token has no sub');

  return {
    sub: c.sub,
    name: typeof c.name === 'string' ? c.name : null,
    email: typeof c.email === 'string' ? c.email : null,
    workspaces: parseWorkspacesClaim(c.workspaces),
  };
}

/** Keep well-formed entries with a known role; anything else grants nothing. */
export function parseWorkspacesClaim(claim: unknown): Membership[] {
  if (!Array.isArray(claim)) return [];
  const seen = new Set<string>();
  const out: Membership[] = [];
  for (const w of claim) {
    if (typeof w !== 'object' || w === null) continue;
    const { id, role } = w as Record<string, unknown>;
    if (typeof id !== 'string' || id === '' || (role !== 'admin' && role !== 'agent') || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, role });
  }
  return out;
}
