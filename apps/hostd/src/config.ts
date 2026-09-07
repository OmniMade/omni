import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** Persisted hostd state: where the control plane is and how to authenticate. */
export interface HostdConfig {
  serverUrl: string;
  credential: string;
}

export function defaultConfigPath(env: { OMNI_HOSTD_CONFIG?: string } = process.env): string {
  if (env.OMNI_HOSTD_CONFIG) return env.OMNI_HOSTD_CONFIG;
  return join(homedir(), ".omni", "hostd.json");
}

/** Read the config; null when the daemon was never enrolled on this machine. */
export async function readConfig(path = defaultConfigPath()): Promise<HostdConfig | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as HostdConfig;
    if (typeof parsed.serverUrl !== "string" || typeof parsed.credential !== "string") {
      throw new Error(`config at ${path} is malformed`);
    }
    return { serverUrl: parsed.serverUrl, credential: parsed.credential };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Write the config with owner-only permissions (0600, owner decision for v1).
 * The file is removed first so a pre-existing file's looser mode can't leak.
 */
export async function writeConfig(
  config: HostdConfig,
  path = defaultConfigPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await rm(path, { force: true });
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}
