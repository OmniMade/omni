import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { ServerToHost } from "@omni/aep";
import type { Db } from "../db/client";
import { hosts, hostCommands, type HostCommandRow } from "../db/schema";
import type { HostRegistry } from "../ws/registry";

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
 * Enqueue a command and push it to the host's live socket when one exists;
 * otherwise it stays pending and the reconnect replay delivers it. Marking the
 * row delivered before sending keeps replay semantics unchanged (unacked
 * commands are re-sent on reconnect, in seq order).
 */
export async function enqueueAndDeliverCommand(
  db: Db,
  registry: HostRegistry,
  hostId: string,
  type: string,
  payload: unknown = {},
): Promise<HostCommandRow> {
  const row = await enqueueCommand(db, hostId, type, payload);
  if (registry.readyForCommands(hostId)) {
    const ws = registry.get(hostId)!;
    await db
      .update(hostCommands)
      .set({ status: "delivered", deliveredAt: new Date() })
      .where(eq(hostCommands.id, row.id));
    ws.send(JSON.stringify({ v: 1, seq: row.seq, type: row.type, payload: row.payload } satisfies ServerToHost));
  }
  return row;
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
