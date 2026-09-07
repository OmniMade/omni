import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { hosts, hostEnrollments } from "../../src/db/schema";
import { adminSession, jsonFetch, startTestServer } from "./helpers";

async function createHost(server: any, cookie: string, name = "macmini") {
  return jsonFetch(server.baseUrl, "/api/v1/hosts", {
    method: "POST",
    body: { name },
    cookie,
  });
}

describe("hosts API & enrollment token lifecycle (Step 2)", () => {
  it("registering a host returns a one-time token plus the connect command", async () => {
    const server = await startTestServer();
    const admin = await adminSession(server);
    try {
      const res = await createHost(server, admin.cookie());
      expect(res.status).toBe(201);
      expect(res.body.host).toMatchObject({ name: "macmini", status: "pending", harnesses: [] });
      expect(res.body.enrollment.token).toMatch(/^omni_enroll_/);
      expect(res.body.enrollment.expiresAt).toBeTruthy();
      expect(res.body.enrollment.command).toContain("omni-hostd connect --server");
      expect(res.body.enrollment.command).toContain(res.body.enrollment.token);
      // Only the hash is stored.
      const rows = await server.runtime.db.select().from(hosts).where(eq(hosts.name, "macmini"));
      expect(rows[0]!.tokenHash).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("exchanges a valid token for a credential and consumes it", async () => {
    const server = await startTestServer();
    const admin = await adminSession(server);
    try {
      const created = await createHost(server, admin.cookie());
      const token = created.body.enrollment.token;

      const enroll = await jsonFetch(server.baseUrl, "/api/v1/hosts/enroll", {
        method: "POST",
        body: { token },
      });
      expect(enroll.status).toBe(200);
      expect(enroll.body.credential).toMatch(/^omni_host_/);

      // Token is single-use: a second exchange names the cause.
      const reuse = await jsonFetch(server.baseUrl, "/api/v1/hosts/enroll", {
        method: "POST",
        body: { token },
      });
      expect(reuse.status).toBe(401);
      expect(reuse.body.error.code).toBe("TOKEN_CONSUMED");

      // The credential hash is now on the host row.
      const rows = await server.runtime.db.select().from(hosts).where(eq(hosts.name, "macmini"));
      expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await server.close();
    }
  });

  it("expired and unknown tokens produce distinct explicit errors", async () => {
    const server = await startTestServer();
    const admin = await adminSession(server);
    try {
      // Expired: create the enrollment row directly with a past expiry.
      const created = await createHost(server, admin.cookie());
      const hostId = created.body.host.id as string;
      await server.runtime.db.insert(hostEnrollments).values({
        hostId,
        tokenHash: Array.from({ length: 64 }, () => "0").join(""),
        expiresAt: new Date(Date.now() - 1000),
      });

      const expired = await jsonFetch(server.baseUrl, "/api/v1/hosts/enroll", {
        method: "POST",
        body: { token: "omni_enroll_expiredfake" },
      });
      // Unknown token (the fake hash above never matches a real token), so:
      expect(expired.status).toBe(401);

      // True expired-token path: expire a real token's row, then use it.
      const created2 = await createHost(server, admin.cookie(), "linuxbox");
      const token2 = created2.body.enrollment.token;
      const hash = createHash("sha256").update(token2).digest("hex");
      await server.runtime.db
        .update(hostEnrollments)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(hostEnrollments.tokenHash, hash));
      const expiredReal = await jsonFetch(server.baseUrl, "/api/v1/hosts/enroll", {
        method: "POST",
        body: { token: token2 },
      });
      expect(expiredReal.status).toBe(401);
      expect(expiredReal.body.error.code).toBe("TOKEN_EXPIRED");

      const unknown = await jsonFetch(server.baseUrl, "/api/v1/hosts/enroll", {
        method: "POST",
        body: { token: "omni_enroll_doesnotexist" },
      });
      expect(unknown.status).toBe(401);
      expect(unknown.body.error.code).toBe("INVALID_TOKEN");
    } finally {
      await server.close();
    }
  });

  it("duplicate host names are rejected with a friendly message", async () => {
    const server = await startTestServer();
    const admin = await adminSession(server);
    try {
      expect((await createHost(server, admin.cookie())).status).toBe(201);
      const dup = await createHost(server, admin.cookie());
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe("NAME_TAKEN");
      expect(dup.body.error.message).toContain("macmini");

      const invalid = await jsonFetch(server.baseUrl, "/api/v1/hosts", {
        method: "POST",
        body: { name: "bad name!" },
        cookie: admin.cookie(),
      });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe("INVALID_NAME");
    } finally {
      await server.close();
    }
  });

  it("renames a host and refuses a name already in use", async () => {
    const server = await startTestServer();
    const admin = await adminSession(server);
    try {
      const a = await createHost(server, admin.cookie(), "host-a");
      await createHost(server, admin.cookie(), "host-b");
      const id = a.body.host.id;

      const renamed = await jsonFetch(server.baseUrl, `/api/v1/hosts/${id}`, {
        method: "PATCH",
        body: { name: "macmini-2" },
        cookie: admin.cookie(),
      });
      expect(renamed.status).toBe(200);
      expect(renamed.body.host.name).toBe("macmini-2");

      const clash = await jsonFetch(server.baseUrl, `/api/v1/hosts/${id}`, {
        method: "PATCH",
        body: { name: "host-b" },
        cookie: admin.cookie(),
      });
      expect(clash.status).toBe(409);
      expect(clash.body.error.code).toBe("NAME_TAKEN");
    } finally {
      await server.close();
    }
  });

  it("rotating a credential issues a new enrollment token and clears the old credential", async () => {
    const server = await startTestServer();
    const admin = await adminSession(server);
    try {
      const created = await createHost(server, admin.cookie());
      const id = created.body.host.id;
      const enroll = await jsonFetch(server.baseUrl, "/api/v1/hosts/enroll", {
        method: "POST",
        body: { token: created.body.enrollment.token },
      });
      const oldCredential = enroll.body.credential;

      const rotated = await jsonFetch(server.baseUrl, `/api/v1/hosts/${id}/rotate-token`, {
        method: "POST",
        cookie: admin.cookie(),
      });
      expect(rotated.status).toBe(200);
      expect(rotated.body.enrollment.token).toMatch(/^omni_enroll_/);

      const rows = await server.runtime.db.select().from(hosts).where(eq(hosts.id, id));
      expect(rows[0]!.tokenHash).toBeNull();

      // The old credential no longer authenticates (WS handshake check).
      const ws = await import("ws");
      await new Promise<void>((resolve) => {
        const client = new ws.default(`${server.wsUrl}/api/v1/ws/host`, {
          headers: { authorization: `Bearer ${oldCredential}` },
        });
        client.on("unexpected-response", (_req, res) => {
          expect(res.statusCode).toBe(401);
          client.close();
          resolve();
        });
        client.on("open", () => {
          throw new Error("old credential must not open a channel");
        });
        client.on("error", () => {
          /* connection refused surfaces here too; unexpected-response asserted above */
        });
      });
    } finally {
      await server.close();
    }
  });

  it("deleting a host removes it and cascades its enrollments and commands", async () => {
    const server = await startTestServer();
    const admin = await adminSession(server);
    try {
      const created = await createHost(server, admin.cookie());
      const id = created.body.host.id;

      const del = await jsonFetch(server.baseUrl, `/api/v1/hosts/${id}`, {
        method: "DELETE",
        cookie: admin.cookie(),
      });
      expect(del.status).toBe(204);

      const remaining = await server.runtime.db.select().from(hosts);
      expect(remaining).toHaveLength(0);
      const enrollments = await server.runtime.db.select().from(hostEnrollments);
      expect(enrollments).toHaveLength(0);

      const missing = await jsonFetch(server.baseUrl, `/api/v1/hosts/${id}`, {
        method: "DELETE",
        cookie: admin.cookie(),
      });
      expect(missing.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("lists hosts with status and inventory", async () => {
    const server = await startTestServer();
    const admin = await adminSession(server);
    try {
      await createHost(server, admin.cookie(), "host-a");
      await createHost(server, admin.cookie(), "host-b");
      const list = await jsonFetch(server.baseUrl, "/api/v1/hosts", {
        cookie: admin.cookie(),
      });
      expect(list.status).toBe(200);
      expect(list.body.hosts.map((h: any) => h.name)).toEqual(["host-a", "host-b"]);
      expect(list.body.hosts[0]).toMatchObject({ status: "pending", harnesses: [] });
    } finally {
      await server.close();
    }
  });
});
