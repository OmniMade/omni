import WebSocket from "ws";
import {
  httpToWs,
  serverToHostSchema,
  type HostStatus,
  type ServerToHost,
  type WorkspaceStatusMessage,
} from "@omni/aep";

/** What `hello` reports about the machine hostd runs on. */
export interface HostInfo {
  os: string;
  arch: string;
  agent: string;
  hostname?: string;
}

export type ChannelEvent =
  | { kind: "ready" }
  | { kind: "command"; command: ServerToHost }
  | { kind: "credential-rejected" }
  | { kind: "closed"; code?: number };

export type ChannelEventHandler = (event: ChannelEvent) => void;

/**
 * One WebSocket connection to /api/v1/ws/host. Lifetime is owned by the
 * daemon loop, which owns reconnect/backoff; this class only reports events.
 */
export class ChannelClient {
  #ws: WebSocket | null = null;
  #closedByUs = false;

  constructor(
    private readonly serverUrl: string,
    private readonly credential: string,
    private readonly info: HostInfo,
    private readonly emit: ChannelEventHandler,
  ) {}

  connect(): void {
    this.#closedByUs = false;
    const ws = new WebSocket(`${httpToWs(this.serverUrl)}/api/v1/ws/host`, {
      headers: { authorization: `Bearer ${this.credential}` },
    });
    this.#ws = ws;

    ws.on("unexpected-response", (_req, res) => {
      if (res.statusCode === 401 || res.statusCode === 403) {
        this.emit({ kind: "credential-rejected" });
      } else {
        this.emit({ kind: "closed" });
      }
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
    });

    ws.on("open", () => {
      ws.send(
        JSON.stringify({ v: 1, type: "hello", os: this.info.os, arch: this.info.arch, agent: this.info.agent, ...(this.info.hostname === undefined ? {} : { hostname: this.info.hostname }) }),
      );
      this.emit({ kind: "ready" });
    });

    ws.on("message", (data) => {
      const parsed = serverToHostSchema.safeParse(JSON.parse(data.toString("utf8")));
      if (!parsed.success) {
        // The server validates everything it sends; a violation is fatal.
        ws.close(4001, "protocol violation from server");
        return;
      }
      this.emit({ kind: "command", command: parsed.data });
    });

    ws.on("error", () => {
      // 'close' always follows 'error' in ws; events flow from there.
    });

    ws.on("close", (code) => {
      this.#ws = null;
      this.emit({ kind: "closed", code });
    });
  }

  sendHeartbeat(beat: Omit<HostStatus, "v" | "type">): void {
    this.#send({ v: 1, type: "host.status", ...beat });
  }

  sendResult(seq: number, ok: boolean, error?: string): void {
    this.#send({ v: 1, type: "result", seq, ok, ...(error === undefined ? {} : { error }) });
  }

  /** Workspace report: phase transitions, progress, snapshots. */
  sendWorkspaceStatus(message: Omit<WorkspaceStatusMessage, "v" | "type">): void {
    this.#send({ v: 1, type: "workspace.status", ...message });
  }

  /** Intentional close (shutdown) — the daemon will not reconnect after it. */
  close(): void {
    this.#closedByUs = true;
    this.#ws?.close(1000, "hostd shutting down");
    this.#ws = null;
  }

  get closedByUs(): boolean {
    return this.#closedByUs;
  }

  #send(message: unknown): void {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(message));
    }
  }
}
