import { asc, desc, eq } from "drizzle-orm";
import type {
  WorkspaceEvent,
  WorkspaceStatusMessage,
  WorkspaceSummary,
} from "@omni/aep";
import type { Db } from "../db/client";
import {
  workspaces,
  workspaceEvents,
  type WorkspaceEventRow,
  type WorkspaceRow,
} from "../db/schema";
import { HttpError } from "../lib/http-error";
import { enqueueAndDeliverCommand } from "./commands";
import { requireHost } from "./hosts";
import type { HostRegistry } from "../ws/registry";

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const URL_MAX_LEN = 2048;

/** Activity-log kind implied by a status when the host did not set one. */
const KIND_BY_STATUS: Record<WorkspaceStatusMessage["status"], WorkspaceEvent["kind"]> = {
  queued: "info",
  cloning: "progress",
  adopting: "progress",
  syncing: "sync",
  ready: "ready",
  error: "error",
};

export function workspaceToDto(row: WorkspaceRow): WorkspaceSummary {
  return {
    id: row.id,
    hostId: row.hostId,
    name: row.name,
    repoUrl: row.repoUrl,
    origin: row.origin,
    rootPath: row.rootPath,
    defaultBranch: row.defaultBranch,
    status: row.status,
    currentBranch: row.currentBranch,
    head: row.head,
    dirty: row.dirty,
    sizeBytes: row.sizeBytes,
    error: row.error,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function workspaceEventToDto(row: WorkspaceEventRow): WorkspaceEvent {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    kind: row.kind as WorkspaceEvent["kind"],
    message: row.message,
    data: row.data as Record<string, unknown>,
    ts: row.ts.toISOString(),
  };
}

/** Sanitize the last path segment of a URL/path into a valid workspace name. */
export function deriveWorkspaceName(source: string): string {
  const last = source.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  const stripped = last.replace(/\.git$/, "");
  const sanitized = stripped.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[._-]+/, "");
  return sanitized.slice(0, 64);
}

export function validateWorkspaceName(name: unknown): string {
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    throw new HttpError(
      400,
      "INVALID_NAME",
      "Workspace name must be 1-64 chars: letters, digits, dots, dashes, underscores; start with a letter or digit.",
    );
  }
  return name;
}

/**
 * Light URL check only — git accepts https, ssh/scp, and local path forms, and
 * the authoritative failure comes from git itself on the host.
 */
export function validateRepoUrl(url: unknown): string {
  if (typeof url !== "string" || url.length === 0 || url.length > URL_MAX_LEN || /\s/.test(url)) {
    throw new HttpError(400, "INVALID_REPO_URL", "Repository URL must be a non-empty string without whitespace.");
  }
  return url;
}

export function validateAdoptPath(path: unknown): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > 4096 ||
    /\s/.test(path) ||
    !path.startsWith("/")
  ) {
    throw new HttpError(
      400,
      "INVALID_PATH",
      "Existing path must be an absolute path without whitespace (e.g. /home/me/src/repo).",
    );
  }
  return path;
}

export async function listWorkspaces(db: Db, hostId?: string): Promise<WorkspaceRow[]> {
  const where = hostId ? eq(workspaces.hostId, hostId) : undefined;
  return db
    .select()
    .from(workspaces)
    .where(where)
    .orderBy(asc(workspaces.createdAt));
}

export async function requireWorkspace(db: Db, id: string): Promise<WorkspaceRow> {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
  if (!row) throw new HttpError(404, "WORKSPACE_NOT_FOUND", "No such workspace.");
  return row;
}

/**
 * Register a workspace: insert the row (status queued) and enqueue the clone /
 * adopt command. Name defaults from the URL or path; duplicates 409.
 */
export async function createWorkspace(
  db: Db,
  registry: HostRegistry,
  input: { hostId: string; repoUrl?: unknown; path?: unknown; name?: unknown },
): Promise<WorkspaceRow> {
  const host = await requireHost(db, input.hostId);
  const hasUrl = input.repoUrl !== undefined && input.repoUrl !== null && input.repoUrl !== "";
  const hasPath = input.path !== undefined && input.path !== null && input.path !== "";
  if (hasUrl === hasPath) {
    throw new HttpError(
      400,
      "VALIDATION",
      "Provide exactly one of repoUrl (clone) or path (adopt an existing checkout).",
    );
  }
  const adoptPath = hasPath ? validateAdoptPath(input.path) : null;
  const name = validateWorkspaceName(
    input.name !== undefined && input.name !== null && input.name !== ""
      ? input.name
      : deriveWorkspaceName(hasUrl ? validateRepoUrl(input.repoUrl) : adoptPath!),
  );
  const [row] = await db
    .insert(workspaces)
    .values({
      hostId: host.id,
      name,
      // An adopted checkout is recorded in place; rootPath is the given path
      // until hostd confirms it (hostd never moves or copies it).
      ...(hasUrl
        ? { origin: "cloned" as const, repoUrl: validateRepoUrl(input.repoUrl) }
        : { origin: "adopted" as const, rootPath: adoptPath }),
    })
    .onConflictDoNothing({ target: [workspaces.hostId, workspaces.name] })
    .returning();
  if (!row) {
    throw new HttpError(409, "NAME_TAKEN", `A workspace named "${name}" already exists on this host.`);
  }
  await appendEvent(
    db,
    row.id,
    "registered",
    hasUrl
      ? `Registered clone of ${row.repoUrl}`
      : `Registered existing checkout at ${adoptPath}`,
  );
  await enqueueAndDeliverCommand(db, registry, host.id, "cmd.workspace_clone", {
    workspaceId: row.id,
    name: row.name,
    ...(hasUrl
      ? { mode: "clone" as const, repoUrl: row.repoUrl }
      : { mode: "adopt" as const, path: adoptPath }),
  });
  return row;
}

/**
 * Sync — and retry: from "ready" this enqueues a fetch; from "error" it
 * re-enqueues the original clone/adopt so a failed registration can recover
 * without deleting the row.
 */
export async function syncWorkspace(
  db: Db,
  registry: HostRegistry,
  id: string,
): Promise<WorkspaceRow> {
  const row = await requireWorkspace(db, id);
  if (row.status === "queued" || row.status === "cloning" || row.status === "adopting" || row.status === "syncing") {
    throw new HttpError(
      409,
      "WORKSPACE_NOT_READY",
      `Workspace is ${row.status}; wait for the current operation to finish.`,
    );
  }
  if (row.status === "error") {
    await appendEvent(db, row.id, "info", `Retry requested for "${row.name}"`);
    await enqueueAndDeliverCommand(db, registry, row.hostId, "cmd.workspace_clone", clonePayloadFor(row));
    return row;
  }
  await appendEvent(db, row.id, "sync", `Sync requested for "${row.name}"`);
  await enqueueAndDeliverCommand(db, registry, row.hostId, "cmd.workspace_sync", {
    workspaceId: row.id,
    rootPath: row.rootPath,
    defaultBranch: row.defaultBranch,
  });
  return row;
}

/** The original registration payload, rebuilt from the row for retries. */
function clonePayloadFor(row: WorkspaceRow): Record<string, unknown> {
  if (row.origin === "adopted") {
    return { workspaceId: row.id, name: row.name, mode: "adopt", path: row.rootPath ?? "" };
  }
  return { workspaceId: row.id, name: row.name, mode: "clone", repoUrl: row.repoUrl ?? "" };
}

/**
 * Deletion guard: a workspace cannot be removed while runs reference it. The
 * runs table lands with F003; until then the answer is trivially "no runs",
 * and this function is the single place F003 wires the real query into.
 */
export async function workspaceDeletionBlockedReason(
  _db: Db,
  _id: string,
): Promise<string | null> {
  return null;
}

export async function deleteWorkspace(
  db: Db,
  registry: HostRegistry,
  id: string,
): Promise<WorkspaceRow> {
  const row = await requireWorkspace(db, id);
  const blocked = await workspaceDeletionBlockedReason(db, row.id);
  if (blocked) throw new HttpError(409, "WORKSPACE_IN_USE", blocked);
  if (row.rootPath) {
    // Best-effort cleanup: the host removes the directory only if Omni made it.
    await enqueueAndDeliverCommand(db, registry, row.hostId, "cmd.workspace_delete", {
      workspaceId: row.id,
      rootPath: row.rootPath,
      removeFiles: row.origin === "cloned",
    });
  }
  await db.delete(workspaces).where(eq(workspaces.id, row.id));
  return row;
}

/** Activity-log tail, chronological (newest last). */
export async function listWorkspaceEvents(
  db: Db,
  id: string,
  limit: number,
): Promise<WorkspaceEventRow[]> {
  const rows = await db
    .select()
    .from(workspaceEvents)
    .where(eq(workspaceEvents.workspaceId, id))
    .orderBy(desc(workspaceEvents.id))
    .limit(limit);
  return rows.reverse();
}

async function appendEvent(
  db: Db,
  workspaceId: string,
  kind: WorkspaceEvent["kind"],
  message: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(workspaceEvents).values({ workspaceId, kind, message, data });
}

/**
 * Apply a host's `workspace.status` report: merge status + snapshot into the
 * row, append the activity-log entry, stamp lastSyncedAt when a sync lands.
 * Returns null when the report does not belong to this host (or the workspace
 * was deleted meanwhile) — both are ignored, not errors.
 */
export async function applyWorkspaceStatus(
  db: Db,
  hostId: string,
  msg: WorkspaceStatusMessage,
): Promise<WorkspaceRow | null> {
  const row = await requireWorkspaceOrNull(db, msg.workspaceId);
  if (!row || row.hostId !== hostId) return null;

  const kind = msg.kind ?? KIND_BY_STATUS[msg.status];
  const failed = msg.status === "error" || kind === "error";
  const now = new Date();
  const merged = mergeSnapshot(row, msg.snapshot);
  const [updated] = await db
    .update(workspaces)
    .set({
      status: msg.status,
      error: failed ? (msg.message ?? "unknown error") : null,
      ...merged,
      ...(row.status === "syncing" && msg.status === "ready" ? { lastSyncedAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(workspaces.id, row.id))
    .returning();
  if (msg.message) {
    await appendEvent(db, row.id, kind, msg.message, {
      ...(msg.snapshot ? trimSnapshot(msg.snapshot) : {}),
    });
  }
  return updated ?? null;
}

function mergeSnapshot(
  row: WorkspaceRow,
  snapshot: WorkspaceStatusMessage["snapshot"],
): Partial<WorkspaceRow> {
  if (!snapshot) return {};
  const out: Partial<WorkspaceRow> = {};
  if (snapshot.rootPath !== undefined) out.rootPath = snapshot.rootPath;
  if (snapshot.repoUrl !== undefined) out.repoUrl = snapshot.repoUrl;
  if (snapshot.defaultBranch !== undefined) out.defaultBranch = snapshot.defaultBranch;
  if (snapshot.branch !== undefined) out.currentBranch = snapshot.branch;
  if (snapshot.head !== undefined) out.head = snapshot.head;
  if (snapshot.dirty !== undefined) out.dirty = snapshot.dirty;
  if (snapshot.sizeBytes !== undefined) out.sizeBytes = snapshot.sizeBytes;
  return out;
}

/** Keep the log's jsonb context small: only the fields the host actually sent. */
function trimSnapshot(snapshot: NonNullable<WorkspaceStatusMessage["snapshot"]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

async function requireWorkspaceOrNull(db: Db, id: string): Promise<WorkspaceRow | null> {
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
  return row ?? null;
}
