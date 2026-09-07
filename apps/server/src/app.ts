import { Hono } from "hono";
import { logger } from "hono/logger";
import type { ServerType } from "@hono/node-server";
// Side-effect import: registers the ContextVariableMap augmentation ("user",
// "host") for every consumer of this module, not just our own tsconfig.
import "./context";
import type { ServerConfig } from "./config";
import type { Db } from "./db/client";
import { mountApi } from "./api/index";
import { httpError, errorBody } from "./lib/http-error";
import { registerWebSocket } from "./ws/sockets";
import { HostRegistry, UiHub } from "./ws/registry";

export interface AppDeps {
  db: Db;
  config: ServerConfig;
  registry: HostRegistry;
  uiHub: UiHub;
  /** Re-fetch a host row and push it to UI sockets subscribed to "hosts". */
  broadcastHost(hostId: string): Promise<void>;
  /** Re-fetch a workspace row and push it to UI sockets subscribed to "workspaces". */
  broadcastWorkspace(workspaceId: string): Promise<void>;
}

export type { HostRegistry, UiHub };

/**
 * Assemble the Hono app: REST under /api/v1, both WS endpoints, JSON error
 * handling. The WebSocket upgrade wiring lives in ws/sockets.ts because it
 * needs the @hono/node-ws helper bound to this app instance.
 */
export function buildApp(deps: AppDeps): { app: Hono; injectWebSocket: (server: ServerType) => void } {
  const app = new Hono();

  app.use(logger());
  app.onError((err, c) => httpError(c, err));
  app.notFound((c) => c.json(errorBody("NOT_FOUND", "No such endpoint."), 404));

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  mountApi(app, deps);
  const injectWebSocket = registerWebSocket(app, deps);

  return { app, injectWebSocket };
}
