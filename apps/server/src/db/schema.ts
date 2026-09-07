import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import type { HarnessInfo, HostStatusValue } from "@omni/aep";

/** Single admin row in v1. */
export const users = pgTable("users", {
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One-time enrollment tokens binding a pending host to its credential. */
export const hostEnrollments = pgTable(
  "host_enrollments",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    hostId: uuid("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("host_enrollments_token_hash_key").on(t.tokenHash)],
);

export const hosts = pgTable(
  "hosts",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    name: text("name").notNull().unique(),
    /** SHA-256 hex of the host credential; null until first enrollment. */
    tokenHash: text("token_hash"),
    status: text("status").$type<HostStatusValue>().notNull().default("pending"),
    os: text("os"),
    arch: text("arch"),
    agent: text("agent"),
    hostname: text("hostname"),
    harnesses: jsonb("harnesses")
      .$type<HarnessInfo[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    /** Per-host monotonic counter backing host_commands.seq assignment. */
    commandSeq: integer("command_seq").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("hosts_token_hash_key").on(t.tokenHash)],
);

/** Outbound command queue: survives host disconnects, replayed on reconnect. */
export const hostCommands = pgTable(
  "host_commands",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    hostId: uuid("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload")
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text("status")
      .$type<"pending" | "delivered" | "acked" | "failed">()
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("host_commands_host_seq_key").on(t.hostId, t.seq),
    index("host_commands_replay_idx").on(t.hostId, t.status),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type HostRow = typeof hosts.$inferSelect;
export type HostEnrollmentRow = typeof hostEnrollments.$inferSelect;
export type HostCommandRow = typeof hostCommands.$inferSelect;
