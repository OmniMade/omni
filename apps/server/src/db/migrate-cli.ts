import { createDb } from "./client";
import { runMigrations } from "./migrate";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required (see .env.example)");
  process.exit(1);
}

const { db, sql } = createDb(databaseUrl);
try {
  await runMigrations(db);
  console.log("migrations applied");
} finally {
  await sql.end();
}
