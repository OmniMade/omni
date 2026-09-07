#!/usr/bin/env bun
import { readConfig, defaultConfigPath } from "./config";
import { connect } from "./connect";
import { CredentialRejectedError, runDaemon } from "./daemon";
import { HOSTD_VERSION } from "./version";

const USAGE = `omni-hostd ${HOSTD_VERSION} — the Omni host runtime daemon

Usage:
  omni-hostd                                        Run the daemon with the saved credential
  omni-hostd connect --server URL --token TOKEN     Enroll and run
  omni-hostd --help | --version

Options:
  --server URL            Control plane base URL (https://…), connect only
  --token TOKEN           One-time enrollment token, connect only
  --config PATH           Config file (default: ~/.omni/hostd.json, env OMNI_HOSTD_CONFIG)
  --heartbeat-interval N  Seconds between heartbeats (default 30)
`.trim();

interface ParsedArgs {
  command: string;
  flags: Map<string, string>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const rest = [...argv];
  // The command is the first non-flag argument; a flags-only invocation
  // (e.g. `omni-hostd --heartbeat-interval 5`) runs the daemon.
  let command = "";
  if (rest[0] !== undefined && !rest[0].startsWith("--")) {
    command = rest.shift()!;
  }
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}\n\n${USAGE}`);
    }
    const eq = arg.indexOf("=");
    if (eq > -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      i++;
    } else {
      flags.set(key, "");
    }
  }
  return { command, flags };
}

function main(): void {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (flags.has("help") || command === "help") {
    console.log(USAGE);
    return;
  }
  if (flags.has("version") || command === "version") {
    console.log(`omni-hostd ${HOSTD_VERSION}`);
    return;
  }

  const heartbeatIntervalSec = flags.has("heartbeat-interval")
    ? Number(flags.get("heartbeat-interval"))
    : undefined;
  if (heartbeatIntervalSec !== undefined && (!Number.isFinite(heartbeatIntervalSec) || heartbeatIntervalSec <= 0)) {
    console.error("--heartbeat-interval must be a positive number of seconds");
    process.exitCode = 2;
    return;
  }
  const configPath = flags.get("config");

  if (command === "connect") {
    const serverUrl = flags.get("server");
    const token = flags.get("token");
    if (!serverUrl || !token) {
      console.error("--server and --token are required for connect\n");
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }
    void runConnect(serverUrl, token, configPath, heartbeatIntervalSec);
    return;
  }

  if (command === "" ) {
    void runSaved(configPath, heartbeatIntervalSec);
    return;
  }

  console.error(`unknown command: ${command}\n\n${USAGE}`);
  process.exitCode = 2;
}

async function runConnect(
  serverUrl: string,
  token: string,
  configPath: string | undefined,
  heartbeatIntervalSec: number | undefined,
): Promise<void> {
  let daemon;
  try {
    daemon = await connect({ serverUrl, token, configPath, heartbeatIntervalSec });
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
    return;
  }
  await waitForever(daemon.done);
}

async function runSaved(configPath: string | undefined, heartbeatIntervalSec: number | undefined): Promise<void> {
  const config = await readConfig(configPath ?? defaultConfigPath());
  if (!config) {
    console.error(`no saved credential at ${configPath ?? defaultConfigPath()} — run "omni-hostd connect" first`);
    process.exitCode = 1;
    return;
  }
  await waitForever(runDaemon(config, { heartbeatIntervalSec }).done);
}

async function waitForever(done: Promise<void>): Promise<void> {
  const shutdown = () => process.exit(0);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  try {
    await done;
  } catch (err) {
    if (err instanceof CredentialRejectedError) {
      console.error(err.message);
      process.exit(1);
    }
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  }
}

main();
