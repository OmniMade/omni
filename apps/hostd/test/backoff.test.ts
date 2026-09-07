import { describe, expect, it } from "vitest";
import { backoffDelayMs } from "../src/backoff";

describe("backoffDelayMs", () => {
  it("grows exponentially until the cap", () => {
    const noJitter = () => 1; // 100 % of the exponential delay
    expect(backoffDelayMs(0, { baseMs: 1000, maxMs: 30_000 }, noJitter)).toBe(1000);
    expect(backoffDelayMs(1, { baseMs: 1000, maxMs: 30_000 }, noJitter)).toBe(2000);
    expect(backoffDelayMs(4, { baseMs: 1000, maxMs: 30_000 }, noJitter)).toBe(16_000);
    expect(backoffDelayMs(10, { baseMs: 1000, maxMs: 30_000 }, noJitter)).toBe(30_000);
  });

  it("applies 50–100 % jitter", () => {
    expect(backoffDelayMs(3, { baseMs: 1000 }, () => 0)).toBe(4000); // 50 %
    expect(backoffDelayMs(3, { baseMs: 1000 }, () => 0.5)).toBe(6000); // 75 %
    expect(backoffDelayMs(3, { baseMs: 1000 }, () => 1)).toBe(8000); // 100 %
  });

  it("never leaves the [50 %, 100 %] band for any random draw", () => {
    for (let i = 0; i < 200; i++) {
      const delay = backoffDelayMs(2, { baseMs: 500, maxMs: 5000 });
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(2000);
    }
  });

  it("rejects negative attempts", () => {
    expect(() => backoffDelayMs(-1)).toThrow(RangeError);
  });
});
