import WebSocket from "ws";
import type { ChannelEvent } from "@omni/hostd/channel";
import { ChannelClient } from "@omni/hostd/channel";
import { hostInfo } from "@omni/hostd/daemon";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { enqueueCommand } from "../../src/domain/commands";
import { hostCommands } from "../../src/db/schema";
import { adminSession, cookieJar, jsonFetch, startTestServer, type TestServer } from "./helpers";

interface EnrolledHost {
  hostId: string;
  credential: string;
}

async function enrollHost(server: TestServer, cookie: string, name: string): Promise<EnrolledHost> {
  const created = await jsonFetch(server.baseUrl, "/api/v1/hosts", {
    method: "POST",
    body: { name },
    cookie,
  });
  const enrolled = await jsonFetch(server.baseUrl, "/api/v1/hosts/enroll", {
    method: "POST",
    body: { token: created.body.enrollment.token },
  });
  return { hostId: created.body.host.id, credential: enrolled.body.credential };
}

/** ChannelClient wrapper recording every event with ready/close promises. */
class RecordedChannel {
  readonly events: ChannelEvent[] = [];
  readonly ready: Promise<void>;
  readonly closed: Promise<ChannelEvent>;
  readonly client: ChannelClient;

  constructor(server: TestServer, credential: string) {
    let resolveReady!: () => void;
    let resolveClosed!: (event: ChannelEvent) => void;
    this.ready = new Promise((resolve) => (resolveReady = resolve));
    this.closed = new Promise((resolve) => (resolveClosed = resolve));
    let settled = false;
    this.client = new ChannelClient(server.baseUrl, credential, hostInfo(), (event) => {
      this.events.push(event);
      if (event.kind === "ready") resolveReady();
      if (event.kind === "closed" && !settled) {
        settled = true;
        resolveClosed(event);
      }
    });
  }
}

async function hostStatus(server: TestServer, cookie: string): Promise<any> {
  const list = await jsonFetch(server.baseUrl, "/api/v1/hosts", { cookie });
  return list.body.hosts;
}

async function waitFor<T>(
  probe: () => Promise<T | null | false | undefined>,
  timeoutMs = 10_000,
  intervalMs = 150,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe("host channel (Step 3)", () => {
  it("hello puts the host online with its inventory; heartbeats refresh it", async () => {
    const server = await startTestServer();
    const admin = await adminSession(server);
    try {
      const { credential } = await enrollHost(server, admin.cookie(), "macmini");
      const channel = new RecordedChannel(server, credential);
      channel.client.connect();
      await channel.ready;

      const hosts = await waitFor(async () => {
        const list = await hostStatus(server, admin.cookie());
        return list[0]?.status === "online" ? list : null;
      });
      expect(hosts[0]).toMatchObject({
        name: "macmini",
        status: "online",
        os: hostInfo().os,
        arch: hostInfo().arch,
      });
      expect(hosts[0].agent).toContain("omni-hostd/");

      channel.client.sendHeartbeat({
        uptimeSec: 5,
        runningRuns: 0,
        harnesses: [{ id: "opencode", version: "1.2.3" }],
        diskFreeBytes: 123_456,
      });
      await waitFor(async () => {
        const list = await hostStatus(server, admin.cookie());
        return list[0]?.harnesses?.length === 1 ? list : null;
      });
      channel.client.close();
    } finally {
      await server.close();
    }
  });

  it("a second connection with the same credential closes the older one", async () => {
    const server = await startTestServer();
    const admin = await adminSession(server);
    try {
      const { credential } = await enrollHost(server, admin.cookie(), "dupe");
      const older = new RecordedChannel(server, credential);
      older.client.connect();
      await older.ready;

      const newer = new RecordedChannel(server, credential);
      newer.client.connect();
      await newer.ready;

      const closedEvent = await older.closed;
      expect(closedEvent.kind).toBe("closed");
      expect((closedEvent as { code?: number }).code).toBe(4000); // superseded

      // The host stays online: the newer connection is the current one.
      const hosts = await hostStatus(server, admin.cookie());
      expect(hosts[0].status).toBe("online");
      newer.client.close();
    } finally {
      await server.close();
    }
  });

  it("a malformed channel message drops the connection (fail closed)", async () => {
    const server = await startTestServer();
    const admin = await adminSession(server);
    try {
      const { credential } = await enrollHost(server, admin.cookie(), "misbehave");
      const closed = new Promise<{ code: number }>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${server.runtime.port}/api/v1/ws/host`, {
          headers: { authorization: `Bearer ${credential}` },
        });
        ws.on("open", () => ws.send("this is not json"));
        ws.on("close", (code) => resolve({ code }));
      });
      const { code } = await closed;
      expect(code).toBe(4001);
    } finally {
      await server.close();
    }
  });

  it("silent heartbeats flip the host offline via the sweeper, and the socket is closed", async () => {
    const server = await startTestServer(); // 1 s heartbeat, 3 misses, 1 s sweep
    const admin = await adminSession(server);
    try {
      const { credential } = await enrollHost(server, admin.cookie(), "flaky");
      const channel = new RecordedChannel(server, credential);
      channel.client.connect();
      await channel.ready;
      await waitFor(async () =>
        (await hostStatus(server, admin.cookie()))[0]?.status === "online" ? true : null,
      );

      // Go silent: no more heartbeats. The sweeper must mark offline (~3-4 s).
      const closedEvent = await channel.closed;
      expect((closedEvent as { code?: number }).code).toBe(4002); // heartbeat timeout
      await waitFor(async () =>
        (await hostStatus(server, admin.cookie()))[0]?.status === "offline" ? true : null,
      );
    } finally {
      await server.close();
    }
  });

  it("commands enqueued while offline replay on reconnect, in order, once", async () => {
    const server = await startTestServer();
    const admin = await adminSession(server);
    try {
      const { hostId, credential } = await enrollHost(server, admin.cookie(), "replayer");

      // Host offline: queue two commands.
      await enqueueCommand(server.runtime.db, hostId, "cmd.ping", { note: "first" });
      await enqueueCommand(server.runtime.db, hostId, "cmd.ping", { note: "second" });

      const channel = new RecordedChannel(server, credential);
      channel.client.connect();
      await channel.ready;
      await waitFor(async () =>
        channel.events.filter((e) => e.kind === "command").length === 2 ? true : null,
      );
      const commands = channel.events
        .filter((e): e is Extract<ChannelEvent, { kind: "command" }> => e.kind === "command")
        .map((e) => e.command);
      expect(commands.map((c) => c.type)).toEqual(["cmd.ping", "cmd.ping"]);
      expect(commands.map((c) => c.seq)).toEqual([1, 2]);

      for (const command of commands) {
        channel.client.sendResult(command.seq, true);
      }
      await waitFor(async () => {
        const rows = await server.runtime.db
          .select()
          .from(hostCommands)
          .where(eq(hostCommands.hostId, hostId));
        return rows.length === 2 && rows.every((r) => r.status === "acked") ? rows : null;
      });

      // Reconnect again: acked commands are not replayed.
      channel.client.close();
      await channel.closed;
      const second = new RecordedChannel(server, credential);
      second.client.connect();
      await second.ready;
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(second.events.filter((e) => e.kind === "command")).toEqual([]);
      second.client.close();
    } finally {
      await server.close();
    }
  });

  it("UI sockets subscribed to hosts see online/offline transitions", async () => {
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
      ui.send(JSON.stringify({ type: "subscribe", topic: "hosts" }));

      const { credential } = await enrollHost(server, jar.header, "watched");
      const channel = new RecordedChannel(server, credential);
      channel.client.connect();
      await channel.ready;

      await waitFor(async () =>
        uiEvents.some((e) => e.type === "host.updated" && e.data.status === "online") || null,
      );
      const online = uiEvents.find((e) => e.type === "host.updated" && e.data.status === "online");
      expect(online!.data.name).toBe("watched");
      expect(online!.data.lastSeenAt).toBeTruthy();

      channel.client.close();
      await waitFor(async () =>
        uiEvents.some((e) => e.type === "host.updated" && e.data.status === "offline") || null,
      );
      ui.close();
    } finally {
      await server.close();
    }
  });

  it("rotating the credential closes the live channel with the revoked code", async () => {
    const server = await startTestServer();
    const admin = await adminSession(server);
    try {
      const { hostId, credential } = await enrollHost(server, admin.cookie(), "rotate-me");
      const channel = new RecordedChannel(server, credential);
      channel.client.connect();
      await channel.ready;

      const rotated = await jsonFetch(server.baseUrl, `/api/v1/hosts/${hostId}/rotate-token`, {
        method: "POST",
        cookie: admin.cookie(),
      });
      expect(rotated.status).toBe(200);

      const closedEvent = await channel.closed;
      expect((closedEvent as { code?: number }).code).toBe(4003); // revoked

      await waitFor(async () =>
        (await hostStatus(server, admin.cookie()))[0]?.status === "offline" ? true : null,
      );
    } finally {
      await server.close();
    }
  });
});
