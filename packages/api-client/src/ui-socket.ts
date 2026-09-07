import { uiServerEventSchema, type UiServerEvent, type UiTopic } from "@omni/aep";
import { backoffDelayMs } from "./backoff";

/** Minimal WebSocket-like surface the UiSocket needs (browser or ws). */
export interface WebSocketLike {
  readyState?: number; // 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: () => void): void;
}

export type SocketFactory = (url: string) => WebSocketLike;

/**
 * UI live-events socket: one connection, topic subscriptions, automatic
 * reconnect with backoff. Invalid server events are ignored, not fatal —
 * the UI falls back to REST data until the next valid event.
 */
export class UiSocket {
  #ws: WebSocketLike | null = null;
  #subscriptions = new Set<UiTopic>();
  #closedByUs = false;
  #attempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly url: string,
    private readonly onEvent: (event: UiServerEvent) => void,
    private readonly socketFactory: SocketFactory = defaultSocketFactory,
  ) {}

  connect(): void {
    this.#closedByUs = false;
    const ws = this.socketFactory(this.url);
    this.#ws = ws;

    ws.addEventListener("open", () => {
      this.#attempt = 0;
      for (const topic of this.#subscriptions) {
        ws.send(JSON.stringify({ type: "subscribe", topic }));
      }
    });
    ws.addEventListener("message", (event) => {
      let raw: unknown;
      try {
        raw = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      const parsed = uiServerEventSchema.safeParse(raw);
      if (parsed.success) this.onEvent(parsed.data);
    });
    ws.addEventListener("close", () => {
      this.#ws = null;
      if (this.#closedByUs) return;
      const delay = backoffDelayMs(this.#attempt++);
      this.#reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }

  subscribe(topic: UiTopic): void {
    this.#subscriptions.add(topic);
    // Buffered while connecting; the 'open' handler flushes all subscriptions.
    if (this.#ws?.readyState === 1) this.#ws.send(JSON.stringify({ type: "subscribe", topic }));
  }

  unsubscribe(topic: UiTopic): void {
    this.#subscriptions.delete(topic);
    if (this.#ws?.readyState === 1) this.#ws.send(JSON.stringify({ type: "unsubscribe", topic }));
  }

  close(): void {
    this.#closedByUs = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#ws?.close();
    this.#ws = null;
  }
}

function defaultSocketFactory(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

// Duplicated from hostd on purpose: api-client must not depend on the host
// runtime package; the math is 8 lines and shared by tests of both.
export { backoffDelayMs };
