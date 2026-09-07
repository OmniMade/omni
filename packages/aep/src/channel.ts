import { z } from "zod";

/**
 * Host channel protocol (control plane ↔ host runtime), version 1.
 *
 * This module covers the channel *envelopes* — hello, heartbeats, command
 * envelopes and acks. The Agent Event Protocol event vocabulary (`run.started`,
 * `agent.message`, …) lands with F003 in `events.ts`.
 */

export const PROTOCOL_VERSION = 1 as const;

/** Map an http(s) base URL to its ws(s) counterpart, trailing slash trimmed. */
export function httpToWs(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}`;
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}`;
  throw new Error(`expected an http(s) URL, got: ${url}`);
}

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

/** A harness binary detected on the host (`opencode`, `claude`, `codex`, …). */
export const harnessInfoSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
});
export type HarnessInfo = z.infer<typeof harnessInfoSchema>;

export const hostStatusEnum = z.enum(["pending", "online", "offline"]);
export type HostStatusValue = z.infer<typeof hostStatusEnum>;

/** Host as exposed over REST and the UI socket. */
export const hostSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: hostStatusEnum,
  os: z.string().nullable(),
  arch: z.string().nullable(),
  agent: z.string().nullable(),
  hostname: z.string().nullable(),
  harnesses: z.array(harnessInfoSchema),
  lastSeenAt: z.string().nullable(),
  createdAt: z.string(),
});
export type HostSummary = z.infer<typeof hostSummarySchema>;

// ---------------------------------------------------------------------------
// host → server
// ---------------------------------------------------------------------------

/** First message after the socket opens (credential was checked at upgrade). */
export const helloSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal("hello"),
  os: z.string().min(1),
  arch: z.string().min(1),
  /** hostd version string, e.g. "omni-hostd 0.1.0 (bun 1.4.2)" */
  agent: z.string().min(1),
  hostname: z.string().min(1).optional(),
});
export type Hello = z.infer<typeof helloSchema>;

/** Periodic heartbeat (default every 30 s). */
export const hostStatusSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal("host.status"),
  uptimeSec: z.number().int().nonnegative(),
  runningRuns: z.number().int().nonnegative(),
  harnesses: z.array(harnessInfoSchema),
  diskFreeBytes: z.number().nonnegative().optional(),
});
export type HostStatus = z.infer<typeof hostStatusSchema>;

/** Ack / outcome for a server→host command, keyed by the command's `seq`. */
export const commandResultSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal("result"),
  seq: z.number().int().nonnegative(),
  ok: z.boolean(),
  error: z.string().optional(),
});
export type CommandResult = z.infer<typeof commandResultSchema>;

/**
 * Everything the host may send. Strict union on purpose: a message that does
 * not parse drops the connection (fail closed, F001 business rule). New host →
 * server message kinds are added here and ship server-side first.
 */
export const hostToServerSchema = z.discriminatedUnion("type", [
  helloSchema,
  hostStatusSchema,
  commandResultSchema,
]);
export type HostToServer = z.infer<typeof hostToServerSchema>;

// ---------------------------------------------------------------------------
// server → host
// ---------------------------------------------------------------------------

/**
 * Command envelope. `type` is any `cmd.*` string rather than a closed enum so
 * that an old hostd can still *parse* (and fail-ack) a command from a newer
 * server instead of tearing down the channel.
 */
export const serverToHostSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  seq: z.number().int().nonnegative(),
  type: z.string().regex(/^cmd\.[a-z_]+$/, "command type must be cmd.<name>"),
  payload: z.unknown().optional(),
});
export type ServerToHost = z.infer<typeof serverToHostSchema>;

/** Commands every F001 hostd understands. */
export const knownCommandSchema = z.enum(["cmd.ping"]);
export type KnownCommand = z.infer<typeof knownCommandSchema>;

// ---------------------------------------------------------------------------
// UI socket (server ↔ web UI)
// ---------------------------------------------------------------------------

export const uiTopicSchema = z.enum(["hosts"]);
export type UiTopic = z.infer<typeof uiTopicSchema>;

export const uiClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("subscribe"), topic: uiTopicSchema }),
  z.object({ type: z.literal("unsubscribe"), topic: uiTopicSchema }),
]);
export type UiClientMessage = z.infer<typeof uiClientMessageSchema>;

export const uiServerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("host.updated"), data: hostSummarySchema }),
  z.object({ type: z.literal("host.deleted"), data: z.object({ id: z.uuid() }) }),
]);
export type UiServerEvent = z.infer<typeof uiServerEventSchema>;
