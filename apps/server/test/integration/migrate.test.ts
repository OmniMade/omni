import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { jsonFetch, migrationsAreIdempotent, startTestServer } from "./helpers";

describe("migrations & boot (Step 1)", () => {
  it("applies migrations, boots the server, and serves /healthz", async () => {
    const server = await startTestServer();
    try {
      const { status, body } = await jsonFetch(server.baseUrl, "/healthz");
      expect(status).toBe(200);
      expect(body).toEqual({ status: "ok" });

      // Re-applying migrations on the already-migrated DB is a no-op.
      await migrationsAreIdempotent(server.runtime.config.databaseUrl);
    } finally {
      await server.close();
    }
  });

  it("creates the documented F001 tables with their key columns", async () => {
    const server = await startTestServer();
    try {
      const rows = await server.runtime.db.execute<{
        table_name: string;
        column_name: string;
      }>(`SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`);
      const byTable = new Map<string, string[]>();
      for (const row of rows) {
        const list = byTable.get(row.table_name) ?? [];
        list.push(row.column_name);
        byTable.set(row.table_name, list);
      }
      // drizzle_migrations lives in its own schema, not public.
      expect(new Set(byTable.keys())).toEqual(
        new Set(["users", "host_enrollments", "hosts", "host_commands"]),
      );
      expect(byTable.get("host_enrollments")).toContain("token_hash");
      expect(byTable.get("host_enrollments")).toContain("expires_at");
      expect(byTable.get("host_enrollments")).toContain("consumed_at");
      expect(byTable.get("hosts")).toContain("status");
      expect(byTable.get("host_commands")).toContain("seq");
    } finally {
      await server.close();
    }
  });
});
