import { randomBytes } from "node:crypto";
import postgres from "postgres";
import type { ServerConfig } from "../../src/config";
import { runMigrations } from "../../src/db/migrate";
import { startOmni, type OmniRuntime } from "../../src/runtime";

export interface TestServer {
  runtime: OmniRuntime;
  baseUrl: string;
  /** ws:// base for raw WebSocket clients. */
  wsUrl: string;
  close(): Promise<void>;
}

let dbCounter = 0;

function pgBase(): string {
  const base = process.env.OMNI_TEST_PG_BASE;
  if (!base) throw new Error("integration global setup did not run (missing OMNI_TEST_PG_BASE)");
  return base;
}

/** CREATE/DROP DATABASE cannot be parameterized; the name is [a-z0-9_] by construction. */
function quoteIdent(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unsafe db name: ${name}`);
  return `"${name}"`;
}

/** Boot a server on an ephemeral port against a fresh per-caller database. */
export async function startTestServer(
  configOverrides: Partial<Omit<ServerConfig, "databaseUrl">> = {},
): Promise<TestServer> {
  const dbName = `omni_it_${process.pid}_${++dbCounter}`;
  const admin = postgres(`${pgBase()}/postgres`, { max: 1 });
  await admin.unsafe(`CREATE DATABASE ${quoteIdent(dbName)}`);
  await admin.end();

  const runtime = await startOmni({
    databaseUrl: `${pgBase()}/${dbName}`,
    autoMigrate: true,
    config: {
      heartbeatIntervalSec: 1,
      heartbeatMisses: 3,
      offlineSweepSec: 1,
      port: 0,
      sessionSecret: new Uint8Array(randomBytes(32)),
      ephemeralSessionSecret: false,
      ...configOverrides,
    },
  });

  return {
    runtime,
    baseUrl: runtime.baseUrl,
    wsUrl: runtime.baseUrl.replace(/^http/, "ws"),
    async close() {
      await runtime.close();
      const dropper = postgres(`${pgBase()}/postgres`, { max: 1 });
      await dropper.unsafe(`DROP DATABASE ${quoteIdent(dbName)} WITH (FORCE)`);
      await dropper.end();
    },
  };
}

/** Minimal cookie jar for driving cookie-authenticated REST flows. */
export function cookieJar() {
  let cookie = "";
  return {
    get header(): string {
      return cookie;
    },
    capture(res: Response): void {
      const set = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
      if (set.length > 0) {
        cookie = set.map((entry) => entry.split(";")[0]).join("; ");
      }
    },
    clear(): void {
      cookie = "";
    },
  };
}

/** JSON fetch helper returning status + body. */
export async function jsonFetch(
  baseUrl: string,
  path: string,
  init: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<{ status: number; body: any; res: Response }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, res };
}

/** Migrations apply cleanly on an already-migrated database (idempotence). */
export async function migrationsAreIdempotent(databaseUrl: string): Promise<void> {
  const { createDb } = await import("../../src/db/client.js");
  const handle = createDb(databaseUrl);
  try {
    await runMigrations(handle.db);
  } finally {
    await handle.sql.end();
  }
}

export interface AdminSession {
  server: TestServer;
  cookie: () => string;
}

/** Setup the admin account and return an authenticated helper. */
export async function adminSession(
  server: TestServer,
  username = "admin",
  password = "correct-horse-battery",
): Promise<AdminSession> {
  const jar = cookieJar();
  const { res } = await jsonFetch(server.baseUrl, "/api/v1/auth/setup", {
    method: "POST",
    body: { username, password },
  });
  jar.capture(res);
  return { server, cookie: () => jar.header };
}
