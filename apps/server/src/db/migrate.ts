import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Db } from "./client";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** Apply pending forward-only migrations from apps/server/drizzle. */
export function runMigrations(db: Db): Promise<void> {
  return migrate(db, { migrationsFolder });
}
