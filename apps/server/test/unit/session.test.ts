import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signSession, verifySession } from "../../src/auth/session";

const secret = new Uint8Array(randomBytes(32));

describe("session cookie", () => {
  it("round-trips a signed session", () => {
    const cookie = signSession("018f6b1e-5a1c-7c2e-9f3a-2b6c8d4e0a12", secret);
    expect(verifySession(cookie, secret)).toBe("018f6b1e-5a1c-7c2e-9f3a-2b6c8d4e0a12");
  });

  it("rejects a cookie signed with a different secret", () => {
    const cookie = signSession("user-1", secret);
    expect(verifySession(cookie, new Uint8Array(randomBytes(32)))).toBeNull();
  });

  it("rejects tampered payloads", () => {
    const cookie = signSession("user-1", secret);
    const [userId, expiry, mac] = cookie.split(".");
    const tampered = [`user-2`, expiry!, mac!].join(".");
    expect(verifySession(tampered, secret)).toBeNull();
  });

  it("rejects expired sessions", () => {
    const now = Date.now();
    const cookie = signSession("user-1", secret, now - 8 * 24 * 3600 * 1000);
    expect(verifySession(cookie, secret, now)).toBeNull();
  });

  it("rejects garbage input", () => {
    expect(verifySession(undefined, secret)).toBeNull();
    expect(verifySession("", secret)).toBeNull();
    expect(verifySession("a.b.c", secret)).toBeNull();
    expect(verifySession("user.notanumber.mac", secret)).toBeNull();
  });
});
