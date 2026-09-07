import type { WSContext } from "hono/ws";
import type { UiServerEvent, UiTopic } from "@omni/aep";

/** Close codes for the host channel. */
export const CLOSE_CODE = {
  superseded: 4000,
  protocolViolation: 4001,
  heartbeatTimeout: 4002,
  revoked: 4003,
} as const;

/**
 * Live WS connection per host. A second connection for the same host closes
 * the older socket (host restarted with a stale connection).
 */
export class HostRegistry {
  #conns = new Map<string, WSContext>();
  #helloed = new Set<WSContext>();

  register(hostId: string, ws: WSContext): void {
    const existing = this.#conns.get(hostId);
    if (existing && existing !== ws) {
      existing.close(CLOSE_CODE.superseded, "superseded by newer connection");
      this.#helloed.delete(existing);
    }
    this.#conns.set(hostId, ws);
  }

  /** The socket completed its hello — the reconnect replay has run. */
  markHello(ws: WSContext): void {
    this.#helloed.add(ws);
  }

  /**
   * True when commands may be live-delivered to this host: a registered
   * socket that has said hello. Before hello, a live send would race the
   * reconnect replay (which would then re-send the same seq); commands for
   * pre-hello sockets stay pending and the replay delivers them in order.
   */
  readyForCommands(hostId: string): boolean {
    const ws = this.#conns.get(hostId);
    return ws !== undefined && this.#helloed.has(ws);
  }

  /** True when the removed socket was the registered one. */
  unregister(hostId: string, ws: WSContext): boolean {
    if (this.#conns.get(hostId) !== ws) return false;
    this.#conns.delete(hostId);
    this.#helloed.delete(ws);
    return true;
  }

  get(hostId: string): WSContext | undefined {
    return this.#conns.get(hostId);
  }

  closeHost(hostId: string, code: number, reason: string): boolean {
    const ws = this.#conns.get(hostId);
    if (!ws) return false;
    this.#conns.delete(hostId);
    this.#helloed.delete(ws);
    ws.close(code, reason);
    return true;
  }

  closeAll(): void {
    for (const ws of this.#conns.values()) ws.close(1001, "server shutting down");
    this.#conns.clear();
    this.#helloed.clear();
  }
}

/** UI sockets grouped by subscribed topic; F001 ships the "hosts" topic. */
export class UiHub {
  #sockets = new Map<WSContext, Set<UiTopic>>();

  add(ws: WSContext): void {
    this.#sockets.set(ws, new Set());
  }

  remove(ws: WSContext): void {
    this.#sockets.delete(ws);
  }

  subscribe(ws: WSContext, topic: UiTopic): void {
    this.#sockets.get(ws)?.add(topic);
  }

  unsubscribe(ws: WSContext, topic: UiTopic): void {
    this.#sockets.get(ws)?.delete(topic);
  }

  broadcastTopic(topic: UiTopic, event: UiServerEvent): void {
    const data = JSON.stringify(event);
    for (const [ws, topics] of this.#sockets) {
      if (topics.has(topic) && ws.readyState === 1 /* OPEN */) {
        ws.send(data);
      }
    }
  }

  closeAll(): void {
    for (const ws of this.#sockets.keys()) ws.close(1001, "server shutting down");
    this.#sockets.clear();
  }
}
