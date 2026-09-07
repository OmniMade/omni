import { describe, expect, it } from "vitest";
import {
  hostToServerSchema,
  serverToHostSchema,
  uiClientMessageSchema,
  uiServerEventSchema,
} from "../src/index";

describe("hostToServerSchema", () => {
  it("accepts a valid hello", () => {
    const msg = {
      v: 1,
      type: "hello",
      os: "darwin",
      arch: "arm64",
      agent: "omni-hostd 0.1.0",
      hostname: "macmini",
    };
    expect(hostToServerSchema.parse(msg)).toEqual(msg);
  });

  it("accepts a valid heartbeat", () => {
    const msg = {
      v: 1,
      type: "host.status",
      uptimeSec: 120,
      runningRuns: 0,
      harnesses: [{ id: "opencode", version: "1.0.5" }],
      diskFreeBytes: 12345,
    };
    expect(hostToServerSchema.parse(msg)).toEqual(msg);
  });

  it("rejects negative uptime and missing fields", () => {
    expect(
      hostToServerSchema.safeParse({
        v: 1,
        type: "host.status",
        uptimeSec: -1,
        runningRuns: 0,
        harnesses: [],
      }).success,
    ).toBe(false);
    expect(
      hostToServerSchema.safeParse({ v: 1, type: "host.status" }).success,
    ).toBe(false);
  });

  it("rejects unknown message kinds (fail closed)", () => {
    expect(
      hostToServerSchema.safeParse({ v: 1, type: "event", data: {} }).success,
    ).toBe(false);
  });

  it("rejects a wrong protocol version", () => {
    expect(
      hostToServerSchema.safeParse({
        v: 2,
        type: "hello",
        os: "linux",
        arch: "x64",
        agent: "x",
      }).success,
    ).toBe(false);
  });
});

describe("serverToHostSchema", () => {
  it("accepts known and unknown cmd types (forward compatible)", () => {
    expect(
      serverToHostSchema.parse({ v: 1, seq: 3, type: "cmd.ping" }),
    ).toEqual({ v: 1, seq: 3, type: "cmd.ping" });
    expect(
      serverToHostSchema.parse({ v: 1, seq: 4, type: "cmd.start_run", payload: {} }),
    ).toEqual({ v: 1, seq: 4, type: "cmd.start_run", payload: {} });
  });

  it("rejects non-command types", () => {
    expect(
      serverToHostSchema.safeParse({ v: 1, seq: 1, type: "hello" }).success,
    ).toBe(false);
  });
});

describe("ui socket schemas", () => {
  it("round-trips subscribe and host events", () => {
    expect(
      uiClientMessageSchema.parse({ type: "subscribe", topic: "hosts" }),
    ).toEqual({ type: "subscribe", topic: "hosts" });
    expect(
      uiClientMessageSchema.safeParse({ type: "subscribe", topic: "runs" })
        .success,
    ).toBe(false);

    const event = {
      type: "host.updated",
      data: {
        id: "018f6b1e-5a1c-7c2e-9f3a-2b6c8d4e0a12",
        name: "macmini",
        status: "online",
        os: "darwin",
        arch: "arm64",
        agent: "omni-hostd 0.1.0",
        hostname: "macmini.local",
        harnesses: [],
        lastSeenAt: "2026-09-06T12:00:00.000Z",
        createdAt: "2026-09-06T11:00:00.000Z",
      },
    };
    expect(uiServerEventSchema.parse(event)).toEqual(event);
  });
});
