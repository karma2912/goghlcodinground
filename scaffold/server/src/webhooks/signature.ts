import { createHmac, timingSafeEqual } from 'node:crypto';

/** Pigeon rejects nothing older than this; neither do we, and we apply it to the future too. */
export const TOLERANCE_SECONDS = 5 * 60;

export interface ParsedSignature {
  timestamp: number;
  signatures: Buffer[]; // each v1 value, decoded from hex (32 bytes)
}

/**
 * Parse `t=<unix seconds>,v1=<hex>[,v1=<hex>...]`. Returns null for anything
 * malformed: no t, more than one t, a non-numeric t, or no well-formed v1.
 */
export function parseSignatureHeader(header: unknown): ParsedSignature | null {
  if (typeof header !== 'string' || header.length === 0 || header.length > 1024) return null;
  let timestamp: number | null = null;
  const signatures: Buffer[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) return null;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      if (timestamp !== null || !/^\d{1,12}$/.test(value)) return null;
      timestamp = Number(value);
    } else if (key === 'v1') {
      if (!/^[0-9a-fA-F]{64}$/.test(value)) return null;
      signatures.push(Buffer.from(value, 'hex'));
    }
    // other schemes (v0, v2 ...) are ignored, so Pigeon can add one later
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/** HMAC-SHA256 over the exact bytes "<t>.<raw body>". */
export function computeSignature(secret: string, timestamp: number, rawBody: Buffer): Buffer {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
}

export type VerifyResult = { ok: true; timestamp: number } | { ok: false; reason: 'missing' | 'malformed' | 'mismatch' | 'expired' };

export function verifySignature(opts: {
  header: unknown;
  rawBody: Buffer;
  secret: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): VerifyResult {
  if (opts.header === undefined || opts.header === '') return { ok: false, reason: 'missing' };
  const parsed = parseSignatureHeader(opts.header);
  if (!parsed) return { ok: false, reason: 'malformed' };

  const expected = computeSignature(opts.secret, parsed.timestamp, opts.rawBody);
  // every candidate is compared in constant time; lengths are equal (32 bytes)
  const matches = parsed.signatures.some((sig) => timingSafeEqual(sig, expected));
  if (!matches) return { ok: false, reason: 'mismatch' };

  // The timestamp is only trusted once the HMAC proves Pigeon chose it.
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSeconds ?? TOLERANCE_SECONDS;
  if (Math.abs(now - parsed.timestamp) > tolerance) return { ok: false, reason: 'expired' };

  return { ok: true, timestamp: parsed.timestamp };
}
