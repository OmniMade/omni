import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { OmniClient, type FetchLike } from "@omni/api-client";
import { startOmni, type OmniRuntime } from "@omni/server/runtime";
import type { WorkspaceSummary } from "@omni/aep";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);

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
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  return child;
}

async function gitIn(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd });
  return stdout;
}

let repoCounter = 0;

/** A source repo with one commit on `main` — the "upstream" the host clones from. */
async function makeSourceRepo(parent: string): Promise<string> {
  const src = join(parent, `src-repo-${++repoCounter}`);
  await mkdir(src, { recursive: true });
  await gitIn(src, "init", "--initial-branch", "main");
  await gitIn(src, "config", "user.email", "e2e@omni.local");
  await gitIn(src, "config", "user.name", "omni e2e");
  await writeFile(join(src, "README.md"), "# e2e fixture\n");
  await gitIn(src, "add", ".");
  await gitIn(src, "commit", "-m", "initial");
  return src;
}

async function waitForWorkspace(
  predicate: (ws: WorkspaceSummary) => boolean,
  timeoutMs = 30_000,
): Promise<WorkspaceSummary> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const all = await client.listWorkspaces();
    const match = all.find(predicate);
    if (match) return match;
    if (Date.now() > deadline) {
      throw new Error(`waitForWorkspace timed out; workspaces: ${JSON.stringify(all)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/**
 * The standard e2e preamble for F003+: one enrolled host with an empty data
 * directory, ready for workspace registration.
 */
async function enrolledHost(name: string): Promise<{ hostId: string; dataDir: string }> {
  const { enrollment } = await client.createHost(name);
  const dataDir = await mkdtemp(join(tmpdir(), `omni-e2e-${name}-`));
  spawnHostd(
    [
      "connect",
      "--server",
      runtime.baseUrl,
      "--token",
      enrollment.token,
      "--heartbeat-interval",
      String(HEARTBEAT_SEC),
    ],
    { OMNI_HOSTD_DATA: dataDir },
  );
  const deadline = Date.now() + 30_000;
  for (;;) {
    const hosts = await client.listHosts();
    const host = hosts.find((h) => h.name === name && h.status === "online");
    if (host) return { hostId: host.id, dataDir };
    if (Date.now() > deadline) throw new Error(`host ${name} never came online`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

describe("F002 end-to-end: workspaces on a real hostd", () => {
  it("clones a repo, syncs after upstream commits, and deletes cloned files", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "omni-e2e-ws-"));
    try {
      const src = await makeSourceRepo(scratch);
      const { hostId, dataDir } = await enrolledHost("ws-host");

      // Register by URL — hostd clones into <data>/workspaces/<name>.
      const created = await client.createWorkspace({ hostId, repoUrl: src });
      expect(created).toMatchObject({ name: "src-repo-1", origin: "cloned", status: "queued" });

      const ready = await waitForWorkspace((w) => w.id === created.id && w.status === "ready");
      expect(ready).toMatchObject({
        defaultBranch: "main",
        currentBranch: "main",
        dirty: false,
        rootPath: join(dataDir, "workspaces", "src-repo-1"),
      });
      expect(ready.head).toMatch(/^[0-9a-f]{40}$/);
      expect(ready.repoUrl).toBe(src);
      await expect(readFile(join(ready.rootPath!, "README.md"), "utf8")).resolves.toContain("e2e fixture");

      // Activity log recorded registration and the clone.
      const events = await client.listWorkspaceEvents(created.id);
      expect(events.map((e) => e.kind)).toContain("registered");
      expect(events.at(-1)!.kind).toBe("ready");

      // Upstream moves; sync fast-forwards the checkout.
      await writeFile(join(src, "feature.txt"), "new upstream work\n");
      await gitIn(src, "add", ".");
      await gitIn(src, "commit", "-m", "second");
      await client.syncWorkspace(created.id);

      const synced = await waitForWorkspace((w) => w.id === created.id && w.head !== ready.head);
      expect(synced.lastSyncedAt).toBeTruthy();
      await expect(readFile(join(synced.rootPath!, "feature.txt"), "utf8")).resolves.toContain("upstream work");
      const afterSync = await client.listWorkspaceEvents(created.id);
      expect(afterSync.some((e) => e.kind === "sync")).toBe(true);
      expect(afterSync.at(-1)!.message).toContain("fast-forwarded");

      // Deleting a cloned workspace removes its directory from the host
      // (async: the command travels to the daemon first — poll for it).
      await client.deleteWorkspace(created.id);
      expect((await client.listWorkspaces()).find((w) => w.id === created.id)).toBeUndefined();
      const gone = join(synced.rootPath!, "README.md");
      for (let i = 0; i < 100; i++) {
        try {
          await stat(gone);
        } catch {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      await expect(stat(gone)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("surfaces a failed clone with retry, and adopts an existing checkout without copying", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "omni-e2e-ws-"));
    try {
      const { hostId, dataDir } = await enrolledHost("ws-host-2");
      const lateRepo = join(scratch, "late-repo");

      // The URL points nowhere yet: the clone fails with git's own error.
      const failed = await client.createWorkspace({ hostId, repoUrl: lateRepo, name: "late" });
      const errored = await waitForWorkspace((w) => w.id === failed.id && w.status === "error");
      expect(errored.error).toMatch(/does not exist|not found/);

      // The repo appears; retrying (via sync) re-runs the clone and recovers.
      await gitIn(scratch, "clone", await makeSourceRepo(scratch), "late-repo");
      await client.syncWorkspace(failed.id);
      const recovered = await waitForWorkspace((w) => w.id === failed.id && w.status === "ready");
      expect(recovered.error).toBeNull();
      expect(recovered.currentBranch).toBe("main");

      // Adopt an existing checkout: recorded in place, never copied or deleted.
      const adoptedPath = join(scratch, "checkout");
      await gitIn(scratch, "clone", await makeSourceRepo(scratch), "checkout");
      const adopted = await client.createWorkspace({ hostId, path: adoptedPath });
      expect(adopted).toMatchObject({ origin: "adopted", rootPath: adoptedPath, status: "queued" });
      const adoptedReady = await waitForWorkspace((w) => w.id === adopted.id && w.status === "ready");
      expect(adoptedReady.rootPath).toBe(adoptedPath);
      expect(adoptedReady.currentBranch).toBe("main");

      await client.deleteWorkspace(adopted.id);
      // The adopted directory survives deletion — Omni never removes it.
      await expect(readFile(join(adoptedPath, "README.md"), "utf8")).resolves.toContain("e2e fixture");
      // The recovered clone is deleted too, and its files do go away (async on the host).
      await client.deleteWorkspace(recovered.id);
      const lateDir = join(dataDir, "workspaces", "late");
      for (let i = 0; i < 100; i++) {
        try {
          await stat(lateDir);
        } catch {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      await expect(stat(lateDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
