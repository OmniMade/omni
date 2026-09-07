import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import type { HarnessInfo } from "@omni/aep";

/** The harness CLIs Omni knows how to detect on a host (adapters land in F003+). */
export const HARNESS_IDS = ["opencode", "claude", "codex"] as const;

/** Pure PATH lookup with executability check — unit-testable, no spawning. */
export function findInPath(binary: string, pathEnv: string | undefined): string | null {
  if (!pathEnv) return null;
  // A path separator inside the binary name means "use as-is", not a PATH scan.
  if (binary.includes("/")) return binary;
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue;
    const candidate = `${dir}/${binary}`;
    if (isExecutableSync(candidate)) return candidate;
  }
  return null;
}

function isExecutableSync(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const VERSION_TIMEOUT_MS = 3_000;

/** Run `<binary> --version` and return its first line, or null on failure. */
export async function runVersion(binary: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(binary, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, VERSION_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const firstLine = out.trim().split("\n")[0]?.trim();
      resolve(firstLine && firstLine.length > 0 ? firstLine : null);
    });
  });
}

/**
 * Detect the harness inventory. A missing binary is simply absent; a binary
 * whose --version fails still counts, as "unknown".
 */
export async function detectHarnesses(env: { PATH?: string } = process.env): Promise<HarnessInfo[]> {
  const found: HarnessInfo[] = [];
  for (const id of HARNESS_IDS) {
    const binary = findInPath(id, env.PATH);
    if (!binary) continue;
    const version = (await runVersion(binary)) ?? "unknown";
    found.push({ id, version });
  }
  return found;
}

const CACHE_TTL_MS = 10 * 60 * 1000;

/** Heartbeats repeat every 30 s; re-detecting binaries each time is noise. */
export class HarnessCache {
  #value: HarnessInfo[] = [];
  #at = 0;

  async get(): Promise<HarnessInfo[]> {
    if (Date.now() - this.#at > CACHE_TTL_MS) {
      this.#value = await detectHarnesses();
      this.#at = Date.now();
    }
    return this.#value;
  }
}
