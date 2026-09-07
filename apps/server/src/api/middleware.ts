import { getCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import { verifySession, SESSION_COOKIE } from "../auth/session";
import type { ServerConfig } from "../config";
import type { Db } from "../db/client";
import { users } from "../db/schema";
import { findHostByCredential } from "../domain/hosts";
import { HttpError } from "../lib/http-error";
import { eq } from "drizzle-orm";

/** Admin guard: valid session cookie → c.get("user"). */
export function requireUser(deps: { db: Db; config: ServerConfig }): MiddlewareHandler {
  return async (c, next) => {
    const userId = verifySession(getCookie(c, SESSION_COOKIE), deps.config.sessionSecret);
    if (userId) {
      const [user] = await deps.db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (user) {
        c.set("user", user);
        await next();
        return;
      }
    }
    throw new HttpError(401, "UNAUTHENTICATED", "Login required.");
  };
}

/** Host-channel guard: Bearer credential → c.get("host"). */
export function requireHostCredential(deps: { db: Db }): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("authorization");
    if (!header?.startsWith("Bearer ")) {
      throw new HttpError(401, "UNAUTHENTICATED", "Host credential required (Authorization: Bearer …).");
    }
    const host = await findHostByCredential(deps.db, header.slice("Bearer ".length).trim());
    if (!host) {
      throw new HttpError(
        401,
        "INVALID_CREDENTIAL",
        "Unknown host credential. Rotate the token and re-enroll the host.",
      );
    }
    c.set("host", host);
    await next();
  };
}
