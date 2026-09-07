import { serve, type ServerType } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Hono } from "hono";
import { buildApp, type AppDeps } from "./app";
import { loadConfig, type ServerConfig } from "./config";
import { createDb, type Db, type DbHandle } from "./db/client";
import { runMigrations } from "./db/migrate";
import {
  findStaleHosts,
  hostToDto,
  markHostOffline,
  requireHost,
} from "./domain/hosts";
import { requireWorkspace, workspaceToDto } from "./domain/workspaces";
import { CLOSE_CODE, HostRegistry, UiHub } from "./ws/registry";

export interface StartOptions {
  /** Overrides DATABASE_URL from the environment. */
  databaseUrl?: string;
  config?: Partial<Omit<ServerConfig, "databaseUrl">>;
  autoMigrate?: boolean;
}

export interface OmniRuntime {
  app: Hono;
  config: ServerConfig;
  db: Db;
  handle: DbHandle;
  registry: HostRegistry;
  uiHub: UiHub;
  port: number;
  baseUrl: string;
  close(): Promise<void>;
}

/**
 * Boot the whole control plane in-process (used by the CLI entry, the
 * integration tests, and e2e). WS endpoints, sweeper, and DB are wired here.
 */
export async function startOmni(opts: StartOptions = {}): Promise<OmniRuntime> {
  const env = { ...process.env };
  if (opts.databaseUrl) env.DATABASE_URL = opts.databaseUrl;
  const config = loadConfig(env);
  Object.assign(config, opts.config ?? {});
  if (opts.autoMigrate !== undefined) config.autoMigrate = opts.autoMigrate;

  const handle = createDb(config.databaseUrl);
  if (config.autoMigrate) await runMigrations(handle.db);

  const registry = new HostRegistry();
  const uiHub = new UiHub();
  const deps: AppDeps = {
    db: handle.db,
    config,
    registry,
    uiHub,
    broadcastHost: async (hostId) => {
      const host = await requireHost(handle.db, hostId);
      uiHub.broadcastTopic("hosts", {
        type: "host.updated",
        data: hostToDto(host),
      });
    },
    broadcastWorkspace: async (workspaceId) => {
      const workspace = await requireWorkspace(handle.db, workspaceId);
      uiHub.broadcastTopic("workspaces", {
        type: "workspace.updated",
        data: workspaceToDto(workspace),
      });
    },
  };

  const { app, injectWebSocket } = buildApp(deps);
  const server = serve({ fetch: app.fetch, port: config.port });
  injectWebSocket(server);
  const port = (server.address() as AddressInfo).port;
  const stopSweeper = startOfflineSweeper(deps);

  return {
    app,
    config,
    db: handle.db,
    handle,
    registry,
    uiHub,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      stopSweeper();
      registry.closeAll();
      uiHub.closeAll();
      // ServerType is a union incl. http2 variants; runtime is always http1.
      (server as Server).closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await handle.sql.end();
    },
  };
}

/** Mark hosts whose heartbeats went silent past the missed-interval threshold. */
function startOfflineSweeper(deps: AppDeps): () => void {
  const { heartbeatIntervalSec, heartbeatMisses, offlineSweepSec } = deps.config;
  const timer = setInterval(async () => {
    try {
      const stale = await findStaleHosts(deps.db, heartbeatIntervalSec, heartbeatMisses);
      for (const host of stale) {
        // No live socket: it simply goes offline. Half-open socket: closed too.
        deps.registry.closeHost(host.id, CLOSE_CODE.heartbeatTimeout, "heartbeat timeout");
        const row = await markHostOffline(deps.db, host.id);
        if (row) await deps.broadcastHost(host.id);
      }
    } catch (err) {
      console.error("offline sweeper failed:", err);
    }
  }, offlineSweepSec * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
