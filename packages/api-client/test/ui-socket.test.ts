import { describe, expect, it, vi } from "vitest";
import { UiSocket, type WebSocketLike } from "../src/ui-socket";

type Listener = (event?: unknown) => void;

/** Scriptable fake socket: tests drive open/message/close manually. */
class FakeSocket implements WebSocketLike {
  listeners = new Map<string, Listener[]>();
  sent: string[] = [];
  readyState = 0; // CONNECTING until the test emits "open"
  factory: ((socket: FakeSocket) => void) | undefined;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.emit("close");
  }
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "open" | "message" | "close", listener: (...args: never[]) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener as Listener]);
  }
  emit(type: "open" | "message" | "close", event?: unknown): void {
    if (type === "open") this.readyState = 1;
    if (type === "close") this.readyState = 3;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("UiSocket", () => {
  it("subscribes on connect and on later subscribe calls", () => {
    const created: FakeSocket[] = [];
    const socket = new UiSocket("ws://x", () => {}, (url) => {
      const fake = new FakeSocket();
      created.push(fake);
      return fake;
    });
    socket.connect();
    expect(created).toHaveLength(1);
    created[0]!.emit("open");
    socket.subscribe("hosts");
    expect(created[0]!.sent).toEqual([JSON.stringify({ type: "subscribe", topic: "hosts" })]);
  });

  it("resubscribes all topics after reconnect", () => {
    vi.useFakeTimers();
    try {
      const created: FakeSocket[] = [];
      const socket = new UiSocket("ws://x", () => {}, () => {
        const fake = new FakeSocket();
        created.push(fake);
        return fake;
      });
      socket.connect();
      created[0]!.emit("open");
      socket.subscribe("hosts");
      created[0]!.emit("close");

      vi.advanceTimersByTime(30_000); // beyond any backoff delay
      created[1]!.emit("open");
      expect(created[1]!.sent).toEqual([JSON.stringify({ type: "subscribe", topic: "hosts" })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers valid host events and ignores invalid ones", () => {
    const events: unknown[] = [];
    const fake = new FakeSocket();
    const socket = new UiSocket("ws://x", (e) => events.push(e), () => fake);
    socket.connect();
    fake.emit("message", { data: "not json" });
    fake.emit("message", { data: JSON.stringify({ type: "nonsense" }) });
    const valid = {
      type: "host.deleted",
      data: { id: "018f6b1e-5a1c-7c2e-9f3a-2b6c8d4e0a12" },
    };
    fake.emit("message", { data: JSON.stringify(valid) });
    expect(events).toEqual([valid]);
  });

  it("does not reconnect after an intentional close", () => {
    vi.useFakeTimers();
    try {
      const created: FakeSocket[] = [];
      const socket = new UiSocket("ws://x", () => {}, () => {
        const fake = new FakeSocket();
        created.push(fake);
        return fake;
      });
      socket.connect();
      created[0]!.emit("open");
      socket.close();
      vi.advanceTimersByTime(60_000);
      expect(created).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
