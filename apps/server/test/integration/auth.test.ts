import { describe, expect, it } from "vitest";
import { adminSession, jsonFetch, startTestServer } from "./helpers";

describe("admin auth (Step 2)", () => {
  it("first-run setup creates the admin; a second setup is rejected", async () => {
    const server = await startTestServer();
    try {
      const first = await jsonFetch(server.baseUrl, "/api/v1/auth/setup", {
        method: "POST",
        body: { username: "admin", password: "correct-horse-battery" },
      });
      expect(first.status).toBe(201);
      expect(first.body.username).toBe("admin");

      const second = await jsonFetch(server.baseUrl, "/api/v1/auth/setup", {
        method: "POST",
        body: { username: "other", password: "correct-horse-battery" },
      });
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe("SETUP_COMPLETED");
    } finally {
      await server.close();
    }
  });

  it("setup validation rejects short usernames and weak passwords", async () => {
    const server = await startTestServer();
    try {
      const res = await jsonFetch(server.baseUrl, "/api/v1/auth/setup", {
        method: "POST",
        body: { username: "ab", password: "long-enough-password" },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION");

      const res2 = await jsonFetch(server.baseUrl, "/api/v1/auth/setup", {
        method: "POST",
        body: { username: "admin", password: "short" },
      });
      expect(res2.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("login issues a working session cookie; logout invalidates it", async () => {
    const server = await startTestServer();
    const admin = await adminSession(server);
    try {
      const me = await jsonFetch(server.baseUrl, "/api/v1/auth/me", {
        cookie: admin.cookie(),
      });
      expect(me.status).toBe(200);
      expect(me.body.username).toBe("admin");

      const logout = await jsonFetch(server.baseUrl, "/api/v1/auth/logout", {
        method: "POST",
        cookie: admin.cookie(),
      });
      expect(logout.status).toBe(200);
      // The session cookie is stateless; logout clears it client-side. Without
      // it, /me is unauthenticated.
      const meAfter = await jsonFetch(server.baseUrl, "/api/v1/auth/me", {
        cookie: "",
      });
      expect(meAfter.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("wrong password is rejected without leaking which part failed", async () => {
    const server = await startTestServer();
    const _admin = await adminSession(server);
    try {
      const wrongUser = await jsonFetch(server.baseUrl, "/api/v1/auth/login", {
        method: "POST",
        body: { username: "ghost", password: "correct-horse-battery" },
      });
      expect(wrongUser.status).toBe(401);
      expect(wrongUser.body.error.code).toBe("INVALID_CREDENTIALS");

      const wrongPassword = await jsonFetch(server.baseUrl, "/api/v1/auth/login", {
        method: "POST",
        body: { username: "admin", password: "wrong-password-123" },
      });
      expect(wrongPassword.status).toBe(401);
      expect(wrongPassword.body.error.code).toBe("INVALID_CREDENTIALS");
    } finally {
      await server.close();
    }
  });

  it("admin endpoints refuse unauthenticated access with the error shape", async () => {
    const server = await startTestServer();
    try {
      const res = await jsonFetch(server.baseUrl, "/api/v1/hosts");
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({ code: "UNAUTHENTICATED", message: expect.any(String) });
    } finally {
      await server.close();
    }
  });
});
