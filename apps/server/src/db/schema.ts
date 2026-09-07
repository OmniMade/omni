import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
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
import type { HarnessInfo, HostStatusValue, WorkspaceOriginValue, WorkspaceStatusValue } from "@omni/aep";

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

/**
 * A git repository registered on a host (F002). Status/snapshot columns are
 * merged from the host's `workspace.status` reports; they are null until the
 * host has reported something.
 */
export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    hostId: uuid("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Null for an adopted repo with no remote configured. */
    repoUrl: text("repo_url"),
    /** cloned: Omni created the directory (deletable); adopted: recorded in place. */
    origin: text("origin").$type<WorkspaceOriginValue>().notNull(),
    /** Absolute on-host path, resolved and reported by hostd. */
    rootPath: text("root_path"),
    defaultBranch: text("default_branch"),
    status: text("status").$type<WorkspaceStatusValue>().notNull().default("queued"),
    currentBranch: text("current_branch"),
    head: text("head"),
    dirty: boolean("dirty"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    /** Last operation error; cleared by the next successful operation. */
    error: text("error"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("workspaces_host_name_key").on(t.hostId, t.name)],
);

/** Append-only activity log behind the workspace's sync/clone history. */
export const workspaceEvents = pgTable(
  "workspace_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    message: text("message").notNull(),
    data: jsonb("data")
      .notNull()
      .default(sql`'{}'::jsonb`),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workspace_events_workspace_idx").on(t.workspaceId, t.id)],
);

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type WorkspaceEventRow = typeof workspaceEvents.$inferSelect;
