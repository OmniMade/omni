import { Hono } from "hono";
import { z } from "zod";
import type { AppDeps } from "../app";
import {
  createHost,
  deleteHost,
  enrollHost,
  hostToDto,
  listHosts,
  markHostOffline,
  renameHost,
  requireHost,
  rotateHostCredential,
  type EnrollmentIssuance,
} from "../domain/hosts";
import { CLOSE_CODE } from "../ws/registry";
import { parseJson, parseIdParam } from "./validate";
import { requireUser } from "./middleware";

const nameSchema = z.object({ name: z.string().min(1).max(64) });
const enrollSchema = z.object({ token: z.string().min(10) });

/**
 * Host endpoints. `/enroll` is public — the one-time token is its
 * authentication; it is registered before the admin guard on purpose so the
 * guard does not swallow it.
 */
export function hostRoutes(deps: AppDeps): Hono {
  const enrollTtlMs = deps.config.enrollTokenTtlMin * 60_000;

  return new Hono()
    .post("/enroll", async (c) => {
      const body = await parseJson(c, enrollSchema);
      const result = await enrollHost(deps.db, { token: body.token });
      return c.json(result);
    })
    .use("*", requireUser(deps))
    .get("/", async (c) => {
      const rows = await listHosts(deps.db);
      return c.json({ hosts: rows.map(hostToDto) });
    })
    .post("/", async (c) => {
      const body = await parseJson(c, nameSchema);
      const { host, enrollment } = await createHost(deps.db, {
        name: body.name,
        enrollTtlMs,
      });
      return c.json(
        { host: hostToDto(host), enrollment: enrollmentPayload(c.req.header("origin") ?? new URL(c.req.url).origin, deps, enrollment) },
        201,
      );
    })
    .patch("/:id", async (c) => {
      const id = parseIdParam(c, "id");
      const body = await parseJson(c, nameSchema);
      const host = await renameHost(deps.db, id, body.name);
      await deps.broadcastHost(host.id);
      return c.json({ host: hostToDto(host) });
    })
    .post("/:id/rotate-token", async (c) => {
      const id = parseIdParam(c, "id");
      const { host, enrollment } = await rotateHostCredential(deps.db, id, enrollTtlMs);
      deps.registry.closeHost(host.id, CLOSE_CODE.revoked, "credential rotated");
      await markHostOffline(deps.db, host.id);
      const fresh = await requireHost(deps.db, host.id);
      await deps.broadcastHost(host.id);
      return c.json({
        host: hostToDto(fresh),
        enrollment: enrollmentPayload(c.req.header("origin") ?? new URL(c.req.url).origin, deps, enrollment),
      });
    })
    .delete("/:id", async (c) => {
      const id = parseIdParam(c, "id");
      await deleteHost(deps.db, id);
      deps.registry.closeHost(id, CLOSE_CODE.revoked, "host deleted");
      deps.uiHub.broadcastTopic("hosts", { type: "host.deleted", data: { id } });
      return c.body(null, 204);
    });
}

/** The one-time token payload shown exactly once at issuance. */
function enrollmentPayload(
  origin: string,
  deps: AppDeps,
  enrollment: EnrollmentIssuance,
): { token: string; expiresAt: string; command: string } {
  const base = deps.config.publicUrl ?? origin;
  return {
    token: enrollment.token,
    expiresAt: enrollment.expiresAt.toISOString(),
    command: `omni-hostd connect --server ${base} --token ${enrollment.token}`,
  };
}
