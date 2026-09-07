import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { ServerToHost } from "@omni/aep";
import type { Db } from "../db/client";
import { hosts, hostCommands, type HostCommandRow } from "../db/schema";

/**
 * Enqueue a command with the next per-host seq. The counter increment is a
 * single UPDATE ... RETURNING, so concurrent enqueues serialize and seq stays
 * unique per host.
 */
export async function enqueueCommand(
  db: Db,
  hostId: string,
  type: string,
  payload: unknown = {},
): Promise<HostCommandRow> {
  const [bumped] = await db
    .update(hosts)
    .set({ commandSeq: sql`${hosts.commandSeq} + 1` })
    .where(eq(hosts.id, hostId))
    .returning({ seq: hosts.commandSeq });
  const [row] = await db
    .insert(hostCommands)
    .values({ hostId, seq: bumped!.seq, type, payload: payload as object })
    .returning();
  return row!;
}

/**
 * Send every unacked command (pending or delivered) to a freshly connected
 * host, in seq order, marking each delivered. The host acks each one; acked
 * rows are never replayed.
 */
export async function replayUnackedCommands(
  db: Db,
  hostId: string,
  send: (command: ServerToHost) => void,
): Promise<number> {
  const rows = await db
    .select()
    .from(hostCommands)
    .where(and(eq(hostCommands.hostId, hostId), inArray(hostCommands.status, ["pending", "delivered"])))
    .orderBy(asc(hostCommands.seq));
  for (const row of rows) {
    await db
      .update(hostCommands)
      .set({ status: "delivered", deliveredAt: new Date() })
      .where(eq(hostCommands.id, row.id));
    send({ v: 1, seq: row.seq, type: row.type, payload: row.payload });
  }
  return rows.length;
}

export async function applyCommandResult(
  db: Db,
  hostId: string,
  seq: number,
  ok: boolean,
): Promise<void> {
  await db
    .update(hostCommands)
    .set({ status: ok ? "acked" : "failed", ackedAt: new Date() })
    .where(and(eq(hostCommands.hostId, hostId), eq(hostCommands.seq, seq)));
}
