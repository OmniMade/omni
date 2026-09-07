import type { Context } from "hono";
import type { ZodType } from "zod";
import { HttpError } from "../lib/http-error";

/** Parse and validate a JSON request body, mapping failures to the error shape. */
export async function parseJson<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(400, "VALIDATION", "Invalid request body.", parsed.error.issues);
  }
  return parsed.data;
}

/** Validate a path parameter, returning 400 instead of leaking SQL errors. */
export function parseIdParam(c: Context, name: string): string {
  const raw = c.req.param(name) ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    throw new HttpError(400, "VALIDATION", `Path parameter ${name} must be a UUID.`);
  }
  return raw;
}
