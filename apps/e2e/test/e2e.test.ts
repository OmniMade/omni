import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { OmniClient, type FetchLike } from "@omni/api-client";
import { startOmni, type OmniRuntime } from "@omni/server/runtime";
import type { HostSummary } from "@omni/aep";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Node's fetch keeps no cookie jar; this one remembers our session. */
function cookieFetch(): FetchLike {
  let cookie = "";
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    if (cookie) headers.set("cookie", cookie);
    const res = await fetch(input, { ...init, headers });
    const set = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    if (set.length > 0) {
      cookie = set.map((entry) => entry.split(";")[0]).join("; ");
    }
    return res;
  };
}

const HOSTD_ENTRY = fileURLToPath(new URL("../../hostd/src/index.ts", import.meta.url));
const HEARTBEAT_SEC = 2;

let postgres: StartedTestContainer;
let runtime: OmniRuntime;
let client: OmniClient;
const children: ChildProcess[] = [];

beforeAll(async () => {
  postgres = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: "omni", POSTGRES_PASSWORD: "omni-e2e", POSTGRES_DB: "omni" })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();

  runtime = await startOmni({
    databaseUrl: `postgres://omni:omni-e2e@${postgres.getHost()}:${postgres.getMappedPort(5432)}/omni`,
    autoMigrate: true,
    config: {
      port: 0,
      heartbeatIntervalSec: HEARTBEAT_SEC,
      heartbeatMisses: 3,
      offlineSweepSec: 1,
      sessionSecret: new Uint8Array(32).fill(7),
      ephemeralSessionSecret: false,
    },
  });
  client = new OmniClient(runtime.baseUrl, cookieFetch());
  await client.setup({ username: "admin", password: "correct-horse-battery" });
});

afterAll(async () => {
  for (const child of children) {
    child.kill("SIGKILL");
  }
  await runtime.close();
  await postgres.stop();
});

/** Spawn a real hostd process (the same code `bun build --compile` bundles). */
function spawnHostd(args: string[], extraEnv: Record<string, string> = {}): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", HOSTD_ENTRY, ...args], {
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

function captureOutput(child: ChildProcess): () => string {
  let out = "";
  child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  return () => out;
}

async function waitForHost(
  predicate: (host: HostSummary) => boolean,
  timeoutMs = 30_000,
): Promise<HostSummary> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hosts = await client.listHosts();
    const match = hosts.find(predicate);
    if (match) return match;
    if (Date.now() > deadline) {
      throw new Error(`waitForHost timed out; hosts: ${JSON.stringify(hosts)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("F001 end-to-end: enroll → online → offline → restart → rotation", () => {
  it("takes a host from enrollment to online in the UI API", async () => {
    const { enrollment } = await client.createHost("macmini");

    const configDir = await mkdtemp(join(tmpdir(), "omni-e2e-"));
    const configPath = join(configDir, "hostd.json");
    const env = { OMNI_HOSTD_CONFIG: configPath };
    const daemon = spawnHostd(
      [
        "connect",
        "--server",
        runtime.baseUrl,
        "--token",
        enrollment.token,
        "--heartbeat-interval",
        String(HEARTBEAT_SEC),
      ],
      env,
    );
    const output = captureOutput(daemon);

    const online = await waitForHost((h) => h.name === "macmini" && h.status === "online");
    expect(online.os).toBeTruthy();
    expect(online.arch).toBeTruthy();
    expect(online.agent).toContain("omni-hostd/");

    // The credential was persisted with 0600 — restart uses it, no re-enroll.
    const saved = JSON.parse(await readFile(configPath, "utf8")) as { credential: string };
    expect(saved.credential).toMatch(/^omni_host_/);
    const { stat } = await import("node:fs/promises");
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);

    // Killing hostd flips the host offline within the missed-heartbeat window.
    daemon.kill("SIGTERM");
    await waitForHost((h) => h.name === "macmini" && h.status === "offline");

    // Restarting restores online without re-enrollment (saved credential).
    const restarted = spawnHostd(["--heartbeat-interval", String(HEARTBEAT_SEC)], env);
    captureOutput(restarted);
    await waitForHost((h) => h.name === "macmini" && h.status === "online");

    // Rotation: live daemon gets kicked and exits instead of retrying.
    await client.rotateHostToken(online.id);
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      restarted.on("exit", (code, signal) => resolve({ code, signal }));
    });
    const result = await Promise.race([exit, wait(20_000).then(() => null)]);
    expect(result).not.toBeNull();
    await waitForHost((h) => h.name === "macmini" && h.status === "offline");

    // The old credential is refused for a fresh connect attempt.
    const refused = spawnHostd(["--heartbeat-interval", String(HEARTBEAT_SEC)], env);
    const refusedOut = captureOutput(refused);
    const refusedExit = new Promise<number | null>((resolve) =>
      refused.on("exit", (code) => resolve(code)),
    );
    expect(await Promise.race([refusedExit, wait(20_000).then(() => null as number | null)])).toBe(1);
    // Give the child's stdout pipe a moment to flush past the exit event.
    await wait(500);
    expect(refusedOut()).toContain("rejected this host credential");
  });

  it("keeps two enrolled hosts online at the same time (stable channels)", async () => {
    const [a, b] = await Promise.all([client.createHost("host-a"), client.createHost("host-b")]);

    const dirA = await mkdtemp(join(tmpdir(), "omni-e2e-a-"));
    const dirB = await mkdtemp(join(tmpdir(), "omni-e2e-b-"));
    const daemonA = spawnHostd(
      ["connect", "--server", runtime.baseUrl, "--token", a.enrollment.token, "--heartbeat-interval", String(HEARTBEAT_SEC)],
      { OMNI_HOSTD_CONFIG: join(dirA, "hostd.json") },
    );
    const daemonB = spawnHostd(
      ["connect", "--server", runtime.baseUrl, "--token", b.enrollment.token, "--heartbeat-interval", String(HEARTBEAT_SEC)],
      { OMNI_HOSTD_CONFIG: join(dirB, "hostd.json") },
    );
    captureOutput(daemonA);
    captureOutput(daemonB);

    await waitForHost((h) => h.name === "host-a" && h.status === "online");
    const hostB = await waitForHost((h) => h.name === "host-b" && h.status === "online");

    // Both stay online for a few heartbeat cycles — no cross-channel interference.
    await wait(HEARTBEAT_SEC * 4 * 1000);
    const hosts = await client.listHosts();
    expect(hosts.find((h) => h.name === "host-a")?.status).toBe("online");
    expect(hosts.find((h) => h.name === "host-b")?.status).toBe("online");
    expect(hostB).toBeTruthy();
  });
});
