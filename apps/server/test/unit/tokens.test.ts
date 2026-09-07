import { describe, expect, it } from "vitest";
import { hashToken, mintToken } from "../../src/domain/tokens";

describe("tokens", () => {
  it("mints prefixed url-safe tokens", () => {
    const enroll = mintToken("omni_enroll");
    const host = mintToken("omni_host");
    expect(enroll).toMatch(/^omni_enroll_[A-Za-z0-9_-]{43}$/);
    expect(host).toMatch(/^omni_host_[A-Za-z0-9_-]{43}$/);
    expect(mintToken("omni_host")).not.toBe(host); // unique per mint
  });

  it("hashes deterministically to sha-256 hex", () => {
    const token = "omni_enroll_abc";
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).not.toBe(hashToken("omni_enroll_abd"));
  });
});
