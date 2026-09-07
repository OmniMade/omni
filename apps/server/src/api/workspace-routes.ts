import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps } from "../app";
import {
  createWorkspace,
  deleteWorkspace,
  listWorkspaceEvents,
  listWorkspaces,
  requireWorkspace,
  syncWorkspace,
  workspaceEventToDto,
  workspaceToDto,
} from "../domain/workspaces";
import { parseJson, parseIdParam } from "./validate";
import { requireUser } from "./middleware";
import { HttpError } from "../lib/http-error";

const createSchema = z.object({
  hostId: z.uuid(),
  repoUrl: z.string().optional(),
  path: z.string().optional(),
  name: z.string().optional(),
});

/**
 * Workspace endpoints (admin). All state changes funnel through the host
 * channel; these routes only write rows and enqueue commands.
 */
export function workspaceRoutes(deps: AppDeps): Hono {
  return new Hono()
    .use("*", requireUser(deps))
    .get("/", async (c) => {
      const hostId = c.req.query("hostId");
      if (hostId !== undefined && !z.uuid().safeParse(hostId).success) {
        throw new HttpError(400, "VALIDATION", "hostId must be a UUID.");
      }
      const rows = await listWorkspaces(deps.db, hostId);
      return c.json({ workspaces: rows.map(workspaceToDto) });
    })
    .post("/", async (c) => {
      const body = await parseJson(c, createSchema);
      const row = await createWorkspace(deps.db, deps.registry, body);
      await deps.broadcastWorkspace(row.id);
      return c.json({ workspace: workspaceToDto(row) }, 201);
    })
    .post("/:id/sync", async (c) => {
      const id = parseIdParam(c, "id");
      const row = await syncWorkspace(deps.db, deps.registry, id);
      await deps.broadcastWorkspace(row.id);
      return c.json({ workspace: workspaceToDto(row) });
    })
    .get("/:id/events", async (c) => {
      const id = parseIdParam(c, "id");
      await requireWorkspace(deps.db, id);
      const rawLimit = Number(c.req.query("limit") ?? 50);
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
      const rows = await listWorkspaceEvents(deps.db, id, limit);
      return c.json({ events: rows.map(workspaceEventToDto) });
    })
    .delete("/:id", async (c) => {
      const id = parseIdParam(c, "id");
      const row = await deleteWorkspace(deps.db, deps.registry, id);
      deps.uiHub.broadcastTopic("workspaces", {
        type: "workspace.deleted",
        data: { id: row.id },
      });
      return c.body(null, 204);
    });
}
