import { Hono } from "hono";
import type { AppDeps } from "../app";
import { authRoutes } from "./auth-routes";
import { hostRoutes } from "./host-routes";

/** Mount /api/v1: auth is public-where-noted, everything else admin-only. */
export function mountApi(app: Hono, deps: AppDeps): void {
  const api = new Hono();
  // hostRoutes registers POST /hosts/enroll (token-authenticated) before its
  // admin guard, so the guard never sees the enroll exchange.
  api.route("/auth", authRoutes(deps));
  api.route("/hosts", hostRoutes(deps));
  app.route("/api/v1", api);
}
