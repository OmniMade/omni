import { defaultConfigPath, writeConfig, type HostdConfig } from "./config";
import { runDaemon, type DaemonHandle } from "./daemon";

export interface ConnectOptions {
  serverUrl: string;
  token: string;
  configPath?: string;
  heartbeatIntervalSec?: number;
}

/** Enroll: exchange the one-time token for a persistent credential. */
export async function enroll(opts: ConnectOptions): Promise<HostdConfig> {
  const base = opts.serverUrl.replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}/api/v1/hosts/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: opts.token }),
    });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `could not reach the control plane at ${base} (${cause}).\n` +
        "Enrollment is interactive — check the server address and run the command again.",
    );
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    const code = body?.error?.code ?? "UNKNOWN";
    const message = body?.error?.message ?? res.statusText;
    throw new Error(`enrollment failed (${code}): ${message}`);
  }
  const data = (await res.json()) as { hostId: string; credential: string };
  return { serverUrl: base, credential: data.credential };
}

/** Connect command: enroll, persist the credential (0600), run the daemon. */
export async function connect(opts: ConnectOptions): Promise<DaemonHandle> {
  const config = await enroll(opts);
  const path = opts.configPath ?? defaultConfigPath();
  await writeConfig(config, path);
  console.log(`enrolled — credential saved to ${path} (mode 0600)`);
  return runDaemon(config, { heartbeatIntervalSec: opts.heartbeatIntervalSec });
}
