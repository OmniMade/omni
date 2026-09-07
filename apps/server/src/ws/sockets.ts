import { createNodeWebSocket } from "@hono/node-ws";
import type { ServerType } from "@hono/node-server";
import type { Hono } from "hono";
import type { WSContext, WSEvents, WSMessageReceive } from "hono/ws";
import { hostToServerSchema, uiClientMessageSchema, type HostToServer } from "@omni/aep";
import type { AppDeps } from "../app";
import { requireHostCredential, requireUser } from "../api/middleware";
import { applyHeartbeat, markHostOffline, markHostOnline, storeHostInfo } from "../domain/hosts";
import { applyWorkspaceStatus } from "../domain/workspaces";
import { applyCommandResult, replayUnackedCommands } from "../domain/commands";
import { CLOSE_CODE } from "./registry";

const HELLO_TIMEOUT_MS = 5_000;

/**
 * Async WS handler bodies can outlive a closing server (shutdown race);
 * contain their rejections instead of crashing the process.
 */
function asyncSafe(fn: () => Promise<void>): () => void {
  return () => {
    fn().catch((err) => console.error("ws handler failed:", err));
  };
}

function parseChannelMessage(data: WSMessageReceive): unknown {
  const text = typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8");
  return JSON.parse(text);
}

/**
 * Wire both WS endpoints to the app. Credentials are checked in middleware
 * before the upgrade — a bad credential gets a plain 401, never a socket.
 */
export function registerWebSocket(app: Hono, deps: AppDeps): (server: ServerType) => void {
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.use("/api/v1/ws/host", requireHostCredential(deps));
  app.get("/api/v1/ws/host", upgradeWebSocket((c) => hostHandlers(c.get("host").id, deps)));

  app.use("/api/v1/ws/ui", requireUser(deps));
  app.get("/api/v1/ws/ui", upgradeWebSocket(() => uiHandlers(deps)));

  return injectWebSocket;
}

function hostHandlers(hostId: string, deps: AppDeps): WSEvents {
  let helloSeen = false;
  let helloTimer: ReturnType<typeof setTimeout> | undefined;
  // Messages of one connection are applied strictly in arrival order: two
  // workspace.status reports must never interleave their read-modify-write
  // of the same row (a late "cloning" would overwrite an early "ready").
  let queue: Promise<void> = Promise.resolve();
  return {
    onOpen: (_event, ws) => {
      asyncSafe(async () => {
        deps.registry.register(hostId, ws);
        await markHostOnline(deps.db, hostId);
        await deps.broadcastHost(hostId);
        helloTimer = setTimeout(() => {
          if (!helloSeen) ws.close(CLOSE_CODE.protocolViolation, "hello timeout");
        }, HELLO_TIMEOUT_MS);
      })();
    },
    onMessage: (event, ws) => {
      let raw: unknown;
      try {
        raw = parseChannelMessage(event.data);
      } catch {
        ws.close(CLOSE_CODE.protocolViolation, "malformed json");
        return;
      }
      const parsed = hostToServerSchema.safeParse(raw);
      if (!parsed.success) {
        // Fail closed: an unparseable channel message drops the connection.
        ws.close(CLOSE_CODE.protocolViolation, "protocol violation");
        return;
      }
      const msg = parsed.data;
      queue = queue.then(() => handleMessage(msg, ws)).catch((err) => {
        console.error(`host ${hostId}: message handling failed`, err);
      });
    },
    onClose: (_event, ws) => {
      if (helloTimer) clearTimeout(helloTimer);
      // Superseded sockets must not flip status; only the current one does.
      if (deps.registry.unregister(hostId, ws)) {
        asyncSafe(async () => {
          const row = await markHostOffline(deps.db, hostId);
          if (row) await deps.broadcastHost(hostId);
        })();
      }
    },
  };

  async function handleMessage(msg: HostToServer, ws: WSContext): Promise<void> {
    if (msg.type === "hello") {
      helloSeen = true;
      if (helloTimer) clearTimeout(helloTimer);
      await storeHostInfo(deps.db, hostId, {
        os: msg.os,
        arch: msg.arch,
        agent: msg.agent,
        hostname: msg.hostname,
      });
      // Reconnect replay: everything not yet acked goes out again, in order.
      await replayUnackedCommands(deps.db, hostId, (command) => {
        ws.send(JSON.stringify(command));
      });
      // Only now may commands be live-delivered (see HostRegistry).
      deps.registry.markHello(ws);
      await deps.broadcastHost(hostId);
    } else if (msg.type === "host.status") {
      await applyHeartbeat(deps.db, hostId, { harnesses: msg.harnesses });
    } else if (msg.type === "workspace.status") {
      const updated = await applyWorkspaceStatus(deps.db, hostId, msg);
      if (updated) await deps.broadcastWorkspace(updated.id);
    } else {
      await applyCommandResult(deps.db, hostId, msg.seq, msg.ok);
    }
  }
}

function uiHandlers(deps: AppDeps): WSEvents {
  return {
    onOpen: (_event, ws) => {
      deps.uiHub.add(ws);
    },
    onMessage: (event, ws) => {
      let raw: unknown;
      try {
        raw = parseChannelMessage(event.data);
      } catch {
        ws.close(CLOSE_CODE.protocolViolation, "malformed json");
        return;
      }
      const parsed = uiClientMessageSchema.safeParse(raw);
      if (!parsed.success) {
        ws.close(CLOSE_CODE.protocolViolation, "protocol violation");
        return;
      }
      if (parsed.data.type === "subscribe") deps.uiHub.subscribe(ws, parsed.data.topic);
      else deps.uiHub.unsubscribe(ws, parsed.data.topic);
    },
    onClose: (_event, ws) => {
      deps.uiHub.remove(ws);
    },
  };
}
