import { createNodeWebSocket } from "@hono/node-ws";
import type { ServerType } from "@hono/node-server";
import type { Hono } from "hono";
import type { WSContext, WSEvents, WSMessageReceive } from "hono/ws";
import { hostToServerSchema, uiClientMessageSchema } from "@omni/aep";
import type { AppDeps } from "../app";
import { requireHostCredential, requireUser } from "../api/middleware";
import { applyHeartbeat, markHostOffline, markHostOnline, storeHostInfo } from "../domain/hosts";
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
      asyncSafe(async () => {
        try {
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
            await deps.broadcastHost(hostId);
          } else if (msg.type === "host.status") {
            await applyHeartbeat(deps.db, hostId, { harnesses: msg.harnesses });
          } else {
            await applyCommandResult(deps.db, hostId, msg.seq, msg.ok);
          }
        } catch (err) {
          console.error(`host ${hostId}: message handling failed`, err);
        }
      })();
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
