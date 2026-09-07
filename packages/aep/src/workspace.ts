import { z } from "zod";
import { PROTOCOL_VERSION } from "./version";

/**
 * Workspace protocol (F002): REST/UI DTO, host-channel status reports, and the
 * payloads of the three workspace commands. Workspaces are the place runs
 * execute (F003); this module is deliberately free of run concepts.
 */

export const workspaceStatusEnum = z.enum([
  "queued", // row created, command not yet picked up
  "cloning", // cloning from repoUrl
  "adopting", // validating an existing on-disk checkout
  "syncing", // git fetch --prune (+ fast-forward) in progress
  "ready",
  "error", // operation failed; message surfaced in the UI
]);
export type WorkspaceStatusValue = z.infer<typeof workspaceStatusEnum>;

export const workspaceOriginEnum = z.enum(["cloned", "adopted"]);
export type WorkspaceOriginValue = z.infer<typeof workspaceOriginEnum>;

/** Workspace as exposed over REST and the UI socket ("workspaces" topic). */
export const workspaceSummarySchema = z.object({
  id: z.uuid(),
  hostId: z.uuid(),
  name: z.string(),
  repoUrl: z.string().nullable(),
  origin: workspaceOriginEnum,
  rootPath: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  status: workspaceStatusEnum,
  currentBranch: z.string().nullable(),
  head: z.string().nullable(),
  dirty: z.boolean().nullable(),
  sizeBytes: z.number().nullable(),
  /** Last operation error; set while status is "error" or after a failed sync. */
  error: z.string().nullable(),
  lastSyncedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;

/**
 * Repository facts a host reports with a status message. Every field is
 * optional; the server merges whatever is present.
 */
export const workspaceSnapshotSchema = z.object({
  rootPath: z.string().min(1).optional(),
  repoUrl: z.string().nullable().optional(),
  defaultBranch: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  head: z.string().nullable().optional(),
  dirty: z.boolean().optional(),
  sizeBytes: z.number().nonnegative().nullable().optional(),
});
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;

/** Activity-log kinds; the UI picks an icon/tone per kind. */
export const workspaceEventKindEnum = z.enum([
  "registered",
  "progress",
  "ready",
  "sync",
  "info",
  "warn",
  "error",
]);
export type WorkspaceEventKind = z.infer<typeof workspaceEventKindEnum>;

/** Activity-log entry as served by GET /workspaces/:id/events. */
export const workspaceEventSchema = z.object({
  id: z.number().int(),
  workspaceId: z.uuid(),
  kind: workspaceEventKindEnum,
  message: z.string(),
  data: z.record(z.string(), z.unknown()),
  ts: z.string(),
});
export type WorkspaceEvent = z.infer<typeof workspaceEventSchema>;

// ---------------------------------------------------------------------------
// host → server
// ---------------------------------------------------------------------------

/**
 * Unsolicited workspace report: phase transitions, progress lines, snapshots.
 * Sent whenever hostd learns something about a workspace — the server merges
 * the snapshot and appends `message` (if any) to the activity log.
 */
export const workspaceStatusMessageSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal("workspace.status"),
  workspaceId: z.uuid(),
  status: workspaceStatusEnum,
  /** Activity-log kind for `message`; defaults derive from `status`. */
  kind: workspaceEventKindEnum.optional(),
  message: z.string().optional(),
  snapshot: workspaceSnapshotSchema.optional(),
});
export type WorkspaceStatusMessage = z.infer<typeof workspaceStatusMessageSchema>;

// ---------------------------------------------------------------------------
// server → host command payloads
// ---------------------------------------------------------------------------

/**
 * `cmd.workspace_clone`: register a workspace on the host. mode "clone" fetches
 * `repoUrl` into `<omni-data>/workspaces/<name>`; mode "adopt" takes over the
 * checkout at `path` in place. hostd resolves the real root path either way and
 * reports it back — the server never guesses host paths.
 */
export const workspaceClonePayloadSchema = z.discriminatedUnion("mode", [
  z.object({
    workspaceId: z.uuid(),
    name: z.string().min(1),
    mode: z.literal("clone"),
    repoUrl: z.string().min(1),
  }),
  z.object({
    workspaceId: z.uuid(),
    name: z.string().min(1),
    mode: z.literal("adopt"),
    path: z.string().min(1),
  }),
]);
export type WorkspaceClonePayload = z.infer<typeof workspaceClonePayloadSchema>;

/** `cmd.workspace_sync`: fetch (+ fast-forward when clean) an existing checkout. */
export const workspaceSyncPayloadSchema = z.object({
  workspaceId: z.uuid(),
  rootPath: z.string().min(1),
});
export type WorkspaceSyncPayload = z.infer<typeof workspaceSyncPayloadSchema>;

/**
 * `cmd.workspace_delete`: best-effort on-disk cleanup. `removeFiles` is false
 * for adopted workspaces — Omni never deletes a path it did not create.
 */
export const workspaceDeletePayloadSchema = z.object({
  workspaceId: z.uuid(),
  rootPath: z.string().min(1).nullable(),
  removeFiles: z.boolean(),
});
export type WorkspaceDeletePayload = z.infer<typeof workspaceDeletePayloadSchema>;

/** Commands an F002 hostd understands. */
export const workspaceKnownCommands = [
  "cmd.workspace_clone",
  "cmd.workspace_sync",
  "cmd.workspace_delete",
] as const;
