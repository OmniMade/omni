import { eq } from "drizzle-orm";
import { deleteCookie, setCookie } from "hono/cookie";
import { Hono } from "hono";
import { z } from "zod";
import { hashPassword, verifyPassword } from "../auth/passwords";
import { SESSION_COOKIE, SESSION_TTL_MS, signSession } from "../auth/session";
import type { AppDeps } from "../app";
import { users } from "../db/schema";
import { HttpError } from "../lib/http-error";
import { requireUser } from "./middleware";
import { parseJson } from "./validate";

const credentialsSchema = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(8).max(200),
});

/** Equalizes login timing between "no such user" and "wrong password". */
let dummyHash: string | null = null;

export function authRoutes(deps: AppDeps): Hono {
  return new Hono()
    .post("/setup", async (c) => {
      const body = await parseJson(c, credentialsSchema);
      const [existing] = await deps.db.select({ id: users.id }).from(users).limit(1);
      if (existing) {
        throw new HttpError(409, "SETUP_COMPLETED", "The admin account already exists. Log in instead.");
      }
      const [user] = await deps.db
        .insert(users)
        .values({ username: body.username, passwordHash: await hashPassword(body.password) })
        .returning();
      setSessionCookie(c, user!.id, deps);
      return c.json({ id: user!.id, username: user!.username, createdAt: user!.createdAt.toISOString() }, 201);
    })
    .post("/login", async (c) => {
      const body = await parseJson(c, credentialsSchema);
      const [user] = await deps.db.select().from(users).where(eq(users.username, body.username)).limit(1);
      let valid = false;
      if (user) {
        valid = await verifyPassword(user.passwordHash, body.password);
      } else {
        dummyHash ??= await hashPassword("timing-equalizer");
        await verifyPassword(dummyHash, body.password);
      }
      if (!user || !valid) {
        throw new HttpError(401, "INVALID_CREDENTIALS", "Wrong username or password.");
      }
      setSessionCookie(c, user.id, deps);
      return c.json({ id: user.id, username: user.username, createdAt: user.createdAt.toISOString() });
    })
    .post("/logout", (c) => {
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
      return c.json({ ok: true });
    })
    .get("/me", requireUser(deps), (c) => {
      const user = c.get("user");
      return c.json({ id: user.id, username: user.username, createdAt: user.createdAt.toISOString() });
    });
}

function setSessionCookie(
  c: Parameters<typeof setCookie>[0],
  userId: string,
  deps: AppDeps,
): void {
  setCookie(c, SESSION_COOKIE, signSession(userId, deps.config.sessionSecret), {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    secure: deps.config.cookieSecure,
  });
}
