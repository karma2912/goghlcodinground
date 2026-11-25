// Minimal cookie handling, so we need no extra dependency.

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || Object.hasOwn(out, name)) continue; // first one wins, as browsers send the most specific first
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export interface CookieOptions {
  maxAgeSeconds: number; // 0 deletes the cookie
  path?: string;
  secure: boolean;
}

/** Always HttpOnly and SameSite=Lax: scripts cannot read it, other sites cannot POST with it. */
export function serializeCookie(name: string, value: string, opts: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? '/'}`, `Max-Age=${Math.max(0, Math.floor(opts.maxAgeSeconds))}`, 'HttpOnly', 'SameSite=Lax'];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}
