import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "omni_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Stateless signed session cookie: `userId.expiryMs.hmac`. The HMAC covers
 * userId and expiry, so a tampered cookie fails verification and the server
 * keeps no session table (matches the DATABASE schema: no sessions table).
 */
export function signSession(userId: string, secret: Uint8Array, nowMs = Date.now()): string {
  const body = `${userId}.${nowMs + SESSION_TTL_MS}`;
  return `${body}.${hmac(secret, body)}`;
}

/** Returns the userId for a valid, unexpired cookie; null otherwise. */
export function verifySession(
  cookie: string | undefined,
  secret: Uint8Array,
  nowMs = Date.now(),
): string | null {
  if (!cookie) return null;
  const parts = cookie.split(".");
  if (parts.length !== 3) return null;
  const [userId, expiryRaw, mac] = parts;
  if (!userId || !expiryRaw || !mac) return null;
  const expiry = Number(expiryRaw);
  if (!Number.isInteger(expiry) || expiry < nowMs) return null;
  const expected = hmac(secret, `${userId}.${expiryRaw}`);
  if (!constantTimeEquals(mac, expected)) return null;
  return userId;
}

function hmac(secret: Uint8Array, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
