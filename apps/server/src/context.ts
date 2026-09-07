import type { HostRow, UserRow } from "./db/schema";

declare module "hono" {
  interface ContextVariableMap {
    user: UserRow;
    host: HostRow;
  }
}

export {};
