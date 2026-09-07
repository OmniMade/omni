import { randomBytes } from "node:crypto";

export interface ServerConfig {
  port: number;
  databaseUrl: string;
  autoMigrate: boolean;
  sessionSecret: Uint8Array;
  /** True when SESSION_SECRET was not provided and a per-boot random was minted. */
  ephemeralSessionSecret: boolean;
  cookieSecure: boolean;
  /** Overrides request origin when printing the omni-hostd connect command. */
  publicUrl: string | null;
  heartbeatIntervalSec: number;
  heartbeatMisses: number;
  offlineSweepSec: number;
  enrollTokenTtlMin: number;
}

function num(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive number, got: ${raw}`);
  }
  return value;
}

function bool(env: Record<string, string | undefined>, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required (see .env.example)");
  }
  const secretHex = env.SESSION_SECRET;
  const sessionSecret = secretHex
    ? new Uint8Array(Buffer.from(secretHex, "hex"))
    : new Uint8Array(randomBytes(32));
  if (secretHex && sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 bytes of hex");
  }
  return {
    port: num(env, "PORT", 3000),
    databaseUrl,
    autoMigrate: bool(env, "AUTO_MIGRATE", false),
    sessionSecret,
    ephemeralSessionSecret: !secretHex,
    cookieSecure: bool(env, "COOKIE_SECURE", false),
    publicUrl: env.PUBLIC_URL ?? null,
    heartbeatIntervalSec: num(env, "HEARTBEAT_INTERVAL_SEC", 30),
    heartbeatMisses: num(env, "HEARTBEAT_MISSES", 3),
    offlineSweepSec: num(env, "OFFLINE_SWEEP_SEC", 10),
    enrollTokenTtlMin: num(env, "ENROLL_TOKEN_TTL_MIN", 15),
  };
}
