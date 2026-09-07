import { and, asc, eq, gt, isNull, lt } from "drizzle-orm";
import type { HostSummary } from "@omni/aep";
import type { Db } from "../db/client";
import {
  hosts,
  hostEnrollments,
  type HostEnrollmentRow,
  type HostRow,
} from "../db/schema";
import { HttpError } from "../lib/http-error";
import { hashToken, mintToken } from "./tokens";

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export interface EnrollmentIssuance {
  token: string;
  expiresAt: Date;
}

export function hostToDto(row: HostRow): HostSummary {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    os: row.os,
    arch: row.arch,
    agent: row.agent,
    hostname: row.hostname,
    harnesses: row.harnesses,
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function validateHostName(name: unknown): string {
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    throw new HttpError(
      400,
      "INVALID_NAME",
      "Host name must be 1-64 chars: letters, digits, dots, dashes, underscores; start with a letter or digit.",
    );
  }
  return name;
}

export async function listHosts(db: Db): Promise<HostRow[]> {
  return db.select().from(hosts).orderBy(asc(hosts.createdAt));
}

export async function requireHost(db: Db, hostId: string): Promise<HostRow> {
  const [row] = await db.select().from(hosts).where(eq(hosts.id, hostId)).limit(1);
  if (!row) throw new HttpError(404, "HOST_NOT_FOUND", "No such host.");
  return row;
}

/** Look up a host by credential hash; null when the credential is unknown. */
export async function findHostByCredential(db: Db, credential: string): Promise<HostRow | null> {
  const [row] = await db
    .select()
    .from(hosts)
    .where(eq(hosts.tokenHash, hashToken(credential)))
    .limit(1);
  return row ?? null;
}

async function issueEnrollment(
  db: Db,
  hostId: string,
  ttlMs: number,
): Promise<EnrollmentIssuance> {
  const token = mintToken("omni_enroll");
  const expiresAt = new Date(Date.now() + ttlMs);
  await db.insert(hostEnrollments).values({
    hostId,
    tokenHash: hashToken(token),
    expiresAt,
  });
  return { token, expiresAt };
}

/** Register a host and issue its first one-time enrollment token. */
export async function createHost(
  db: Db,
  input: { name: string; enrollTtlMs: number },
): Promise<{ host: HostRow; enrollment: EnrollmentIssuance }> {
  const name = validateHostName(input.name);
  const [host] = await db
    .insert(hosts)
    .values({ name })
    .onConflictDoNothing({ target: hosts.name })
    .returning();
  if (!host) {
    throw new HttpError(409, "NAME_TAKEN", `A host named "${name}" already exists.`);
  }
  const enrollment = await issueEnrollment(db, host.id, input.enrollTtlMs);
  return { host, enrollment };
}

/**
 * Exchange a one-time enrollment token for a persistent host credential.
 * The consume step is a conditional UPDATE, so two racing enrollees cannot
 * both win; the loser gets an explicit "consumed" error.
 */
export async function enrollHost(
  db: Db,
  input: { token: string },
): Promise<{ hostId: string; credential: string }> {
  const tokenHash = hashToken(input.token);
  const [row]: (HostEnrollmentRow | undefined)[] = await db
    .select()
    .from(hostEnrollments)
    .where(eq(hostEnrollments.tokenHash, tokenHash))
    .limit(1);
  if (!row) {
    throw new HttpError(401, "INVALID_TOKEN", "Unknown enrollment token.");
  }
  const consumed = await db
    .update(hostEnrollments)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(hostEnrollments.id, row.id),
        isNull(hostEnrollments.consumedAt),
        gt(hostEnrollments.expiresAt, new Date()),
      ),
    )
    .returning({ id: hostEnrollments.id });
  if (consumed.length === 0) {
    if (row.consumedAt) {
      throw new HttpError(401, "TOKEN_CONSUMED", "This enrollment token was already used.");
    }
    throw new HttpError(
      401,
      "TOKEN_EXPIRED",
      "This enrollment token has expired. Issue a new one and retry.",
    );
  }
  const credential = mintToken("omni_host");
  await db
    .update(hosts)
    .set({ tokenHash: hashToken(credential), updatedAt: new Date() })
    .where(eq(hosts.id, row.hostId));
  return { hostId: row.hostId, credential };
}

export async function renameHost(db: Db, hostId: string, name: unknown): Promise<HostRow> {
  const valid = validateHostName(name);
  await requireHost(db, hostId);
  try {
    const [row] = await db
      .update(hosts)
      .set({ name: valid, updatedAt: new Date() })
      .where(eq(hosts.id, hostId))
      .returning();
    return row!;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new HttpError(409, "NAME_TAKEN", `A host named "${valid}" already exists.`);
    }
    throw err;
  }
}

/** Drizzle wraps driver errors; the pg unique-violation code sits on the cause chain. */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  while (typeof current === "object" && current !== null) {
    if ((current as { code?: string }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Revoke the host's credential and issue a fresh enrollment token. The WS
 * layer closes any live connection; the host must re-enroll to reconnect.
 */
export async function rotateHostCredential(
  db: Db,
  hostId: string,
  enrollTtlMs: number,
): Promise<{ host: HostRow; enrollment: EnrollmentIssuance }> {
  const host = await requireHost(db, hostId);
  const [updated] = await db
    .update(hosts)
    .set({ tokenHash: null, updatedAt: new Date() })
    .where(eq(hosts.id, host.id))
    .returning();
  const enrollment = await issueEnrollment(db, host.id, enrollTtlMs);
  return { host: updated!, enrollment };
}

/**
 * Deletion guard: a host cannot be removed while runs reference it. The runs
 * table lands with F003; until then the answer is trivially "no runs", and
 * this function is the single place F003 wires the real query into.
 */
export async function hostDeletionBlockedReason(_db: Db, _hostId: string): Promise<string | null> {
  return null;
}

export async function deleteHost(db: Db, hostId: string): Promise<void> {
  const host = await requireHost(db, hostId);
  const blocked = await hostDeletionBlockedReason(db, host.id);
  if (blocked) throw new HttpError(409, "HOST_IN_USE", blocked);
  await db.delete(hosts).where(eq(hosts.id, host.id));
}

// ---------------------------------------------------------------------------
// Channel-driven status updates
// ---------------------------------------------------------------------------

/** Set online on WS open; returns the updated row. */
export async function markHostOnline(db: Db, hostId: string): Promise<HostRow> {
  const [row] = await db
    .update(hosts)
    .set({ status: "online", lastSeenAt: new Date(), updatedAt: new Date() })
    .where(eq(hosts.id, hostId))
    .returning();
  return row!;
}

/** Set offline when the current socket closes or heartbeats time out. */
export async function markHostOffline(db: Db, hostId: string): Promise<HostRow | null> {
  const [row] = await db
    .update(hosts)
    .set({ status: "offline", updatedAt: new Date() })
    .where(and(eq(hosts.id, hostId), eq(hosts.status, "online")))
    .returning();
  return row ?? null;
}

export async function storeHostInfo(
  db: Db,
  hostId: string,
  info: { os: string; arch: string; agent: string; hostname?: string },
): Promise<void> {
  await db
    .update(hosts)
    .set({
      os: info.os,
      arch: info.arch,
      agent: info.agent,
      ...(info.hostname === undefined ? {} : { hostname: info.hostname }),
      updatedAt: new Date(),
    })
    .where(eq(hosts.id, hostId));
}

/** Apply a heartbeat; also self-heals a host the sweeper marked offline while
 * its socket stayed alive. */
export async function applyHeartbeat(
  db: Db,
  hostId: string,
  beat: { harnesses: HostRow["harnesses"] },
): Promise<void> {
  await db
    .update(hosts)
    .set({
      lastSeenAt: new Date(),
      harnesses: beat.harnesses,
      status: "online",
      updatedAt: new Date(),
    })
    .where(eq(hosts.id, hostId));
}

/** Hosts whose heartbeat has been silent past the missed-interval threshold. */
export async function findStaleHosts(
  db: Db,
  heartbeatIntervalSec: number,
  misses: number,
): Promise<HostRow[]> {
  const cutoff = new Date(Date.now() - heartbeatIntervalSec * misses * 1000);
  return db
    .select()
    .from(hosts)
    .where(and(eq(hosts.status, "online"), lt(hosts.lastSeenAt, cutoff)));
}
