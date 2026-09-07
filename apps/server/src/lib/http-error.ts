import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Coded HTTP error thrown by domain code and mapped to the API error shape. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function errorBody(code: string, message: string, details?: unknown) {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

export function httpError(c: Context, err: unknown): Response {
  if (err instanceof HttpError) {
    return c.json(errorBody(err.code, err.message, err.details), err.status as ContentfulStatusCode);
  }
  console.error("unhandled error:", err);
  return c.json(errorBody("INTERNAL", "Internal server error"), 500);
}
