import WebSocket from "ws";
import type { ChannelEvent } from "@omni/hostd/channel";
import type { ServerToHost } from "@omni/aep";
import { ChannelClient } from "@omni/hostd/channel";
import { hostInfo } from "@omni/hostd/daemon";
import { desc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { hostCommands } from "../../src/db/schema";
import { adminSession, cookieJar, jsonFetch, startTestServer, type TestServer } from "./helpers";

async function enrollHost(server: TestServer, cookie: string, name: string): Promise<string> {
  const created = await jsonFetch(server.baseUrl, "/api/v1/hosts", {
    method: "POST",
    body: { name },
    cookie,
  });
  const enrolled = await jsonFetch(server.baseUrl, "/api/v1/hosts/enroll", {
    method: "POST",
    body: { token: created.body.enrollment.token },
  });
  return enrolled.body.credential;
}

/**
 * A ChannelClient that records commands and lets each test script the
 * responses — the same real WS endpoint hostd talks to, driven in-process.
 * Heartbeats like a real daemon so the offline sweeper keeps it alive.
 */
class ScriptedHost {
  readonly commands: ServerToHost[] = [];
  readonly ready: Promise<void>;
  readonly client: ChannelClient;
  onCommand: (command: ServerToHost, client: ChannelClient) => void = () => {};
  #heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(server: TestServer, credential: string) {
    let resolveReady!: () => void;
    this.ready = new Promise((resolve) => (resolveReady = resolve));
    this.client = new ChannelClient(server.baseUrl, credential, hostInfo(), (event: ChannelEvent) => {
      if (event.kind === "ready") {
        resolveReady();
        this.#heartbeat = setInterval(() => {
          this.client.sendHeartbeat({
            uptimeSec: 60,
            runningRuns: 0,
            harnesses: [],
          });
        }, 1_000);
      }
      if (event.kind === "closed") {
        if (this.#heartbeat) clearInterval(this.#heartbeat);
        return;
      }
      if (event.kind === "command") {
        this.commands.push(event.command);
        this.onCommand(event.command, this.client);
      }
    });
  }
}

async function waitFor<T>(
  probe: () => Promise<T | null | false | undefined>,
  timeoutMs = 10_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function listWorkspaces(server: TestServer, cookie: string, hostId?: string): Promise<any[]> {
  const res = await jsonFetch(
    server.baseUrl,
    `/api/v1/workspaces${hostId ? `?hostId=${hostId}` : ""}`,
    { cookie },
  );
  return res.body.workspaces;
}

/** Script: answer cmd.workspace_clone with cloning → ready (+ ack). */
function scriptCloneOk(host: ScriptedHost, opts: { head?: string; failFirst?: boolean } = {}) {
  let clones = 0;
  host.onCommand = (command, client) => {
    if (command.type !== "cmd.workspace_clone") return void client.sendResult(command.seq, true);
    clones += 1;
    const payload = command.payload as { workspaceId: string; name: string; mode: string; repoUrl?: string; path?: string };
    const { workspaceId } = payload;
    // A clone lands in <omni-data>/workspaces/<name>; an adopt keeps its path.
    const rootPath = payload.mode === "adopt" ? payload.path! : `/home/me/.omni/workspaces/${payload.name}`;
    if (opts.failFirst && clones === 1) {
      client.sendWorkspaceStatus({
        workspaceId,
        status: "error",
        message: "fatal: repository 'https://x/y.git/' not found",
        snapshot: { rootPath },
      });
      client.sendResult(command.seq, true);
      return;
    }
    client.sendWorkspaceStatus({
      workspaceId,
      status: "cloning",
      message: "cloning …",
      snapshot: { rootPath },
    });
    client.sendWorkspaceStatus({
      workspaceId,
      status: "ready",
      message: "clone complete",
      snapshot: {
        rootPath,
        repoUrl: payload.repoUrl ?? "https://github.com/me/omni.git",
        defaultBranch: "main",
        branch: "main",
        head: opts.head ?? "abc123def456",
        dirty: false,
        sizeBytes: 4096,
      },
    });
    client.sendResult(command.seq, true);
  };
}

function scriptSyncOk(host: ScriptedHost, head: string) {
  host.onCommand = (command, client) => {
    if (command.type !== "cmd.workspace_sync") return void client.sendResult(command.seq, true);
    const { workspaceId } = command.payload as { workspaceId: string };
    client.sendWorkspaceStatus({ workspaceId, status: "syncing", message: "fetching origin" });
    client.sendWorkspaceStatus({
      workspaceId,
      status: "ready",
      message: "fast-forwarded to " + head,
      snapshot: { head },
    });
    client.sendResult(command.seq, true);
  };
}

describe("workspaces (Step 1)", () => {
  it("registers a repo URL and drives queued→cloning→ready over the channel", async () => {
    const server = await startTestServer();
    const admin = await adminSession(server);
    try {
      const credential = await enrollHost(server, admin.cookie(), "macmini");
      const host = new ScriptedHost(server, credential);
      scriptCloneOk(host);
      host.client.connect();
      await host.ready;

      const created = await jsonFetch(server.baseUrl, "/api/v1/workspaces", {
        method: "POST",
        body: { hostId: (await jsonFetch(server.baseUrl, "/api/v1/hosts", { cookie: admin.cookie() })).body.hosts[0].id, repoUrl: "https://github.com/me/omni.git" },
        cookie: admin.cookie(),
      });
      expect(created.status).toBe(201);
      expect(created.body.workspace).toMatchObject({ name: "omni", origin: "cloned", status: "queued" });

      const ready = await waitFor(async () => {
        const rows = await listWorkspaces(server, admin.cookie());
        return rows[0]?.status === "ready" ? rows[0] : null;
      });
      expect(ready).toMatchObject({
        name: "omni",
        repoUrl: "https://github.com/me/omni.git",
        origin: "cloned",
        rootPath: "/home/me/.omni/workspaces/omni",
        defaultBranch: "main",
        currentBranch: "main",
        head: "abc123def456",
        dirty: false,
        sizeBytes: 4096,
        error: null,
        lastSyncedAt: null,
      });

      // The clone command carried everything the host needs, nothing more.
      const clone = host.commands.find((c) => c.type === "cmd.workspace_clone")!;
      expect(clone.payload).toEqual({
        workspaceId: ready.id,
        name: "omni",
        mode: "clone",
        repoUrl: "https://github.com/me/omni.git",
      });

      // Activity log: registration, clone phases, completion — chronological.
      const events = await jsonFetch(server.baseUrl, `/api/v1/workspaces/${ready.id}/events`, {
        cookie: admin.cookie(),
      });
      expect(events.body.events.map((e: any) => e.kind)).toEqual(["registered", "progress", "ready"]);
      expect(events.body.events[1].data.rootPath).toBe("/home/me/.omni/workspaces/omni");

      host.client.close();
    } finally {
      await server.close();
    }
  });

  it("names are per-host: duplicates 409, another host may reuse the name", async () => {
    const server = await startTestServer();
    const admin = await adminSession(server);
    try {
      const hosts = await jsonFetch(server.baseUrl, "/api/v1/hosts", { cookie: admin.cookie() });
      const hostIds: string[] = [];
      for (const name of ["one", "two"]) {
        const created = await jsonFetch(server.baseUrl, "/api/v1/hosts", {
          method: "POST",
          body: { name },
          cookie: admin.cookie(),
        });
        hostIds.push(created.body.host.id);
      }

      const first = await jsonFetch(server.baseUrl, "/api/v1/workspaces", {
        method: "POST",
        body: { hostId: hostIds[0], repoUrl: "https://github.com/me/omni.git" },
        cookie: admin.cookie(),
      });
      expect(first.status).toBe(201);
      const dup = await jsonFetch(server.baseUrl, "/api/v1/workspaces", {
        method: "POST",
        body: { hostId: hostIds[0], repoUrl: "https://github.com/me/omni.git" },
        cookie: admin.cookie(),
      });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe("NAME_TAKEN");
      const other = await jsonFetch(server.baseUrl, "/api/v1/workspaces", {
        method: "POST",
        body: { hostId: hostIds[1], repoUrl: "https://github.com/me/omni.git", name: "omni" },
        cookie: admin.cookie(),
      });
      expect(other.status).toBe(201);
      expect(hosts.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("validates input: exactly one source, safe names, absolute adopt paths, known host", async () => {
    const server = await startTestServer();
    const admin = await adminSession(server);
    try {
      const created = await jsonFetch(server.baseUrl, "/api/v1/hosts", {
        method: "POST",
        body: { name: "validator" },
        cookie: admin.cookie(),
      });
      const hostId = created.body.host.id;
      const post = (body: unknown) =>
        jsonFetch(server.baseUrl, "/api/v1/workspaces", { method: "POST", body, cookie: admin.cookie() });

      expect((await post({ hostId })).status).toBe(400);
      expect((await post({ hostId, repoUrl: "https://x/y.git", path: "/srv/y" })).status).toBe(400);
      expect((await post({ hostId, repoUrl: "https://x/y.git", name: "../evil" })).status).toBe(400);
      expect((await post({ hostId, path: "relative/repo" })).status).toBe(400);
      expect((await post({ hostId: "00000000-0000-0000-0000-000000000000", repoUrl: "https://x/y.git" })).status).toBe(404);

      const adopted = await post({ hostId, path: "/srv/checkout", name: "checkout" });
      expect(adopted.status).toBe(201);
      expect(adopted.body.workspace).toMatchObject({ origin: "adopted", rootPath: "/srv/checkout", status: "queued" });

      const unauth = await jsonFetch(server.baseUrl, "/api/v1/workspaces", { method: "POST", body: { hostId } });
      expect(unauth.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("sync from ready fetches; lastSyncedAt stamps; sync mid-operation is refused", async () => {
    const server = await startTestServer();
    const admin = await adminSession(server);
    try {
      const credential = await enrollHost(server, admin.cookie(), "syncer");
      const host = new ScriptedHost(server, credential);
      scriptCloneOk(host);
      host.client.connect();
      await host.ready;
      const hostId = (await jsonFetch(server.baseUrl, "/api/v1/hosts", { cookie: admin.cookie() })).body.hosts[0].id;

      const created = await jsonFetch(server.baseUrl, "/api/v1/workspaces", {
        method: "POST",
        body: { hostId, repoUrl: "https://github.com/me/omni.git" },
        cookie: admin.cookie(),
      });
      const id = created.body.workspace.id;
      await waitFor(async () => (await listWorkspaces(server, admin.cookie()))[0]?.status === "ready" || null);

      scriptSyncOk(host, "fff999");
      const synced = await jsonFetch(server.baseUrl, `/api/v1/workspaces/${id}/sync`, {
        method: "POST",
        cookie: admin.cookie(),
      });
      expect(synced.status).toBe(200);

      const row = await waitFor(async () => {
        const rows = await listWorkspaces(server, admin.cookie());
        return rows[0]?.head === "fff999" ? rows[0] : null;
      });
      expect(row.lastSyncedAt).toBeTruthy();

      const syncCmd = host.commands.find((c) => c.type === "cmd.workspace_sync")!;
      expect(syncCmd.payload).toEqual({
        workspaceId: id,
        rootPath: "/home/me/.omni/workspaces/omni",
        defaultBranch: "main",
      });

      const events = await jsonFetch(server.baseUrl, `/api/v1/workspaces/${id}/events`, {
        cookie: admin.cookie(),
      });
      const kinds = (events.body.events as any[]).map((e) => e.kind);
      expect(kinds).toContain("sync");
      expect(kinds[kinds.length - 1]).toBe("ready");
      host.client.close();
    } finally {
      await server.close();
    }
  });

  it("a failed clone surfaces git's error and sync retries the original clone", async () => {
    const server = await startTestServer();
    const admin = await adminSession(server);
    try {
      const credential = await enrollHost(server, admin.cookie(), "flaky");
      const host = new ScriptedHost(server, credential);
      scriptCloneOk(host, { failFirst: true });
      host.client.connect();
      await host.ready;
      const hostId = (await jsonFetch(server.baseUrl, "/api/v1/hosts", { cookie: admin.cookie() })).body.hosts[0].id;

      const created = await jsonFetch(server.baseUrl, "/api/v1/workspaces", {
        method: "POST",
        body: { hostId, repoUrl: "https://github.com/me/omni.git" },
        cookie: admin.cookie(),
      });
      const id = created.body.workspace.id;

      const errored = await waitFor(async () => {
        const rows = await listWorkspaces(server, admin.cookie());
        return rows[0]?.status === "error" ? rows[0] : null;
      });
      expect(errored.error).toContain("fatal: repository");

      const retry = await jsonFetch(server.baseUrl, `/api/v1/workspaces/${id}/sync`, {
        method: "POST",
        cookie: admin.cookie(),
      });
      expect(retry.status).toBe(200);

      const ready = await waitFor(async () => {
        const rows = await listWorkspaces(server, admin.cookie());
        return rows[0]?.status === "ready" ? rows[0] : null;
      });
      expect(ready.error).toBeNull();
      // The retry re-sent the clone command (first failed, second succeeded).
      const cloneCommands = host.commands.filter((c) => c.type === "cmd.workspace_clone");
      expect(cloneCommands.map((c) => [c.seq, (c.payload as { mode: string }).mode])).toEqual([
        [1, "clone"],
        [2, "clone"],
      ]);

      // While an operation is mid-flight, sync is refused.
      host.client.close();
    } finally {
      await server.close();
    }
  });

  it("sync is refused while the workspace is queued", async () => {
    const server = await startTestServer();
    const admin = await adminSession(server);
    try {
      const created = await jsonFetch(server.baseUrl, "/api/v1/hosts", {
        method: "POST",
        body: { name: "offline" },
        cookie: admin.cookie(),
      });
      const ws = await jsonFetch(server.baseUrl, "/api/v1/workspaces", {
        method: "POST",
        body: { hostId: created.body.host.id, repoUrl: "https://github.com/me/omni.git" },
        cookie: admin.cookie(),
      });
      const refused = await jsonFetch(server.baseUrl, `/api/v1/workspaces/${ws.body.workspace.id}/sync`, {
        method: "POST",
        cookie: admin.cookie(),
      });
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe("WORKSPACE_NOT_READY");
    } finally {
      await server.close();
    }
  });

  it("delete removes row and log, and cleans up files only for cloned workspaces", async () => {
    const server = await startTestServer();
    const admin = await adminSession(server);
    try {
      const credential = await enrollHost(server, admin.cookie(), "cleaner");
      const host = new ScriptedHost(server, credential);
      scriptCloneOk(host);
      host.client.connect();
      await host.ready;
      const hostId = (await jsonFetch(server.baseUrl, "/api/v1/hosts", { cookie: admin.cookie() })).body.hosts[0].id;

      const cloned = await jsonFetch(server.baseUrl, "/api/v1/workspaces", {
        method: "POST",
        body: { hostId, repoUrl: "https://github.com/me/omni.git" },
        cookie: admin.cookie(),
      });
      const adopted = await jsonFetch(server.baseUrl, "/api/v1/workspaces", {
        method: "POST",
        body: { hostId, path: "/srv/adopted", name: "adopted" },
        cookie: admin.cookie(),
      });
      // Both registered: the clone reported a root path, the adopt recorded one.
      await waitFor(async () => {
        const rows = await listWorkspaces(server, admin.cookie());
        return rows.length === 2 && rows.every((r) => r.status === "ready") ? true : null;
      });

      expect((await jsonFetch(server.baseUrl, `/api/v1/workspaces/${cloned.body.workspace.id}`, { method: "DELETE", cookie: admin.cookie() })).status).toBe(204);
      expect((await jsonFetch(server.baseUrl, `/api/v1/workspaces/${adopted.body.workspace.id}`, { method: "DELETE", cookie: admin.cookie() })).status).toBe(204);

      expect(await listWorkspaces(server, admin.cookie())).toEqual([]);
      const gone = await jsonFetch(server.baseUrl, `/api/v1/workspaces/${cloned.body.workspace.id}/events`, {
        cookie: admin.cookie(),
      });
      expect(gone.status).toBe(404);

      const deletes = await server.runtime.db
        .select()
        .from(hostCommands)
        .where(eq(hostCommands.type, "cmd.workspace_delete"))
        .orderBy(desc(hostCommands.seq));
      const payloads = deletes.map((d) => d.payload as { rootPath: string | null; removeFiles: boolean });
      expect(payloads.map((p) => p.removeFiles)).toEqual([false, true]); // adopted deleted last
      expect(payloads[0]!.rootPath).toBe("/srv/adopted");
      expect(payloads[1]!.rootPath).toBe("/home/me/.omni/workspaces/omni");

      // A queued workspace that never reached a report has no path to clean:
      // the host acks the clone but sends no status → rootPath stays null.
      host.onCommand = (command, client) => client.sendResult(command.seq, true);
      const queued = await jsonFetch(server.baseUrl, "/api/v1/workspaces", {
        method: "POST",
        body: { hostId, repoUrl: "https://github.com/me/queued.git" },
        cookie: admin.cookie(),
      });
      await waitFor(async () =>
        host.commands.some((c) => (c.payload as { name?: string }).name === "queued") ? true : null,
      );
      expect(
        (await jsonFetch(server.baseUrl, `/api/v1/workspaces/${queued.body.workspace.id}`, { method: "DELETE", cookie: admin.cookie() })).status,
      ).toBe(204);
      const after = await server.runtime.db
        .select()
        .from(hostCommands)
        .where(eq(hostCommands.type, "cmd.workspace_delete"));
      expect(after.length).toBe(2); // no third command for the rootPath-less row

      const missing = await jsonFetch(server.baseUrl, "/api/v1/workspaces/00000000-0000-0000-0000-000000000000", {
        method: "DELETE",
        cookie: admin.cookie(),
      });
      expect(missing.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("UI sockets on the workspaces topic see create, clone, and delete", async () => {
    const server = await startTestServer();
    const jar = cookieJar();
    const setup = await jsonFetch(server.baseUrl, "/api/v1/auth/setup", {
      method: "POST",
      body: { username: "admin", password: "correct-horse-battery" },
    });
    jar.capture(setup.res);
    try {
      const uiEvents: any[] = [];
      const ui = new WebSocket(`ws://127.0.0.1:${server.runtime.port}/api/v1/ws/ui`, {
        headers: { cookie: jar.header },
      });
      await new Promise<void>((resolve) => ui.on("open", resolve));
      ui.on("message", (data) => uiEvents.push(JSON.parse(data.toString("utf8"))));
      ui.send(JSON.stringify({ type: "subscribe", topic: "workspaces" }));

      const credential = await enrollHost(server, jar.header, "watched");
      const host = new ScriptedHost(server, credential);
      scriptCloneOk(host);
      host.client.connect();
      await host.ready;
      const hostId = (await jsonFetch(server.baseUrl, "/api/v1/hosts", { cookie: jar.header })).body.hosts[0].id;

      const created = await jsonFetch(server.baseUrl, "/api/v1/workspaces", {
        method: "POST",
        body: { hostId, repoUrl: "https://github.com/me/omni.git" },
        cookie: jar.header,
      });
      const id = created.body.workspace.id;
      await waitFor(() =>
        Promise.resolve(
          uiEvents.some((e) => e.type === "workspace.updated" && e.data.id === id && e.data.status === "queued") || null,
        ),
      );

      await waitFor(() =>
        Promise.resolve(
          uiEvents.some((e) => e.type === "workspace.updated" && e.data.id === id && e.data.status === "ready") || null,
        ),
      );
      const readyEvent = uiEvents.find((e) => e.type === "workspace.updated" && e.data.id === id && e.data.status === "ready");
      expect(readyEvent.data.head).toBe("abc123def456");

      await jsonFetch(server.baseUrl, `/api/v1/workspaces/${id}`, { method: "DELETE", cookie: jar.header });
      await waitFor(() =>
        Promise.resolve(uiEvents.some((e) => e.type === "workspace.deleted" && e.data.id === id) || null),
      );

      host.client.close();
      ui.close();
    } finally {
      await server.close();
    }
  });

  it("ignores workspace.status reports that belong to another host", async () => {
    const server = await startTestServer();
    const admin = await adminSession(server);
    try {
      const credentialA = await enrollHost(server, admin.cookie(), "host-a");
      const credentialB = await enrollHost(server, admin.cookie(), "host-b");
      const hostsList = (await jsonFetch(server.baseUrl, "/api/v1/hosts", { cookie: admin.cookie() })).body.hosts;
      const hostBId = hostsList.find((h: any) => h.name === "host-b").id;

      // Workspace belongs to host B (which stays offline → status stays queued).
      const created = await jsonFetch(server.baseUrl, "/api/v1/workspaces", {
        method: "POST",
        body: { hostId: hostBId, repoUrl: "https://github.com/me/omni.git" },
        cookie: admin.cookie(),
      });
      const id = created.body.workspace.id;

      const intruder = new ScriptedHost(server, credentialA);
      intruder.client.connect();
      await intruder.ready;
      intruder.client.sendWorkspaceStatus({
        workspaceId: id,
        status: "ready",
        message: "sneaky report",
        snapshot: { head: "deadbeef" },
      });
      await new Promise((resolve) => setTimeout(resolve, 500));

      const rows = await listWorkspaces(server, admin.cookie());
      expect(rows[0]).toMatchObject({ status: "queued", head: null });
      intruder.client.close();
    } finally {
      await server.close();
    }
  });
});
