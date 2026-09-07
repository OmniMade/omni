import { arch as osArch, homedir, hostname, platform } from "node:os";
import { statfs } from "node:fs/promises";
import type { HostStatus, ServerToHost } from "@omni/aep";
import {
  workspaceClonePayloadSchema,
  workspaceDeletePayloadSchema,
  workspaceSyncPayloadSchema,
} from "@omni/aep";
import { ChannelClient, type HostInfo } from "./channel";
import type { HostdConfig } from "./config";
import { HarnessCache } from "./detect";
import { backoffDelayMs, sleep } from "./backoff";
import { HOSTD_VERSION } from "./version";
import {
  adoptWorkspace,
  cloneWorkspace,
  defaultDataDir,
  deleteWorkspaceFiles,
  OpQueue,
  syncWorkspace,
} from "./workspace/ops";

export interface DaemonOptions {
  heartbeatIntervalSec?: number;
  /** Test seam: overrides backoff parameters and injects deterministic jitter. */
  backoff?: { baseMs?: number; maxMs?: number; factor?: number; rand?: () => number };
}

/** The server refused the credential: rotation or deletion — stop retrying. */
export class CredentialRejectedError extends Error {
  constructor() {
    super(
      "the control plane rejected this host credential — re-enroll the host (omni-hostd connect …)",
    );
    this.name = "CredentialRejectedError";
  }
}

export function agentString(): string {
  const bun = (globalThis as { Bun?: { version: string } }).Bun;
  const runtime = bun ? `bun ${bun.version}` : `node ${process.version}`;
  return `omni-hostd/${HOSTD_VERSION} (${runtime})`;
}

export function hostInfo(): HostInfo {
  return { os: platform(), arch: osArch(), agent: agentString(), hostname: hostname() };
}

export interface DaemonHandle {
  /** Resolves when the daemon exits; rejects with CredentialRejectedError. */
  done: Promise<void>;
  stop(): void;
}

interface RunOnceOutcome {
  outcome: "closed" | "credential-rejected";
  /** True when the channel came up and said hello before it dropped. */
  everReady: boolean;
}

/**
 * The daemon loop: connect, hello, heartbeat, ack commands; reconnect with
 * exponential backoff + jitter. The backoff resets after a successful hello
 * (a long-lived connection dropping is a fresh failure). Never retries a
 * credential the server has rejected.
 */
export function runDaemon(config: HostdConfig, opts: DaemonOptions = {}): DaemonHandle {
  const heartbeatIntervalMs = (opts.heartbeatIntervalSec ?? 30) * 1000;
  const harnesses = new HarnessCache();
  const workspaceOps = new OpQueue();
  const dataDir = defaultDataDir();
  let stopped = false;
  let current: ChannelClient | null = null;

  const done = (async () => {
    let attempt = 0;
    while (!stopped) {
      const run = await runOnce();
      if (stopped) break;
      if (run.outcome === "credential-rejected") {
        throw new CredentialRejectedError();
      }
      attempt = run.everReady ? 0 : attempt + 1;
      await sleep(backoffDelayMs(attempt, opts.backoff, opts.backoff?.rand));
    }
  })();

  function runOnce(): Promise<RunOnceOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      let everReady = false;
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
      const settle = (outcome: RunOnceOutcome["outcome"]) => {
        if (settled) return;
        settled = true;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        resolve({ outcome, everReady });
      };

      const client = new ChannelClient(config.serverUrl, config.credential, hostInfo(), (event) => {
        switch (event.kind) {
          case "ready": {
            everReady = true;
            void sendHeartbeat(client);
            heartbeatTimer = setInterval(() => void sendHeartbeat(client), heartbeatIntervalMs);
            break;
          }
          case "command": {
            applyCommand(client, event.command);
            break;
          }
          case "credential-rejected": {
            settle("credential-rejected");
            break;
          }
          case "closed": {
            if (client.closedByUs) stopped = true;
            settle("closed");
            break;
          }
        }
      });
      current = client;
      client.connect();
    });
  }

  function sendHeartbeat(client: ChannelClient): void {
    void (async () => {
      client.sendHeartbeat({
        uptimeSec: Math.floor(process.uptime()),
        runningRuns: 0, // no runs until F003
        harnesses: await harnesses.get(),
        ...(await diskFree()),
      });
    })();
  }

  function applyCommand(client: ChannelClient, command: ServerToHost): void {
    if (command.type === "cmd.ping") {
      client.sendResult(command.seq, true);
      return;
    }
    if (command.type === "cmd.workspace_clone") {
      const payload = workspaceClonePayloadSchema.safeParse(command.payload);
      if (!payload.success) {
        client.sendResult(command.seq, false, `invalid workspace_clone payload: ${payload.error.message}`);
        return;
      }
      void workspaceOps
        .run(async () => {
          if (payload.data.mode === "clone") {
            await cloneWorkspace(
              { workspaceId: payload.data.workspaceId, name: payload.data.name, repoUrl: payload.data.repoUrl, dataDir },
              (message) => client.sendWorkspaceStatus(message),
            );
          } else {
            await adoptWorkspace(
              { workspaceId: payload.data.workspaceId, path: payload.data.path },
              (message) => client.sendWorkspaceStatus(message),
            );
          }
        })
        .then(
          () => client.sendResult(command.seq, true),
          (err) =>
            client.sendResult(command.seq, false, err instanceof Error ? err.message : String(err)),
        );
      return;
    }
    if (command.type === "cmd.workspace_sync") {
      const payload = workspaceSyncPayloadSchema.safeParse(command.payload);
      if (!payload.success) {
        client.sendResult(command.seq, false, `invalid workspace_sync payload: ${payload.error.message}`);
        return;
      }
      void workspaceOps
        .run(() =>
          syncWorkspace(
            {
              workspaceId: payload.data.workspaceId,
              rootPath: payload.data.rootPath,
              recordedDefaultBranch: payload.data.defaultBranch,
            },
            (message) => client.sendWorkspaceStatus(message),
          ),
        )
        .then(
          () => client.sendResult(command.seq, true),
          (err) =>
            client.sendResult(command.seq, false, err instanceof Error ? err.message : String(err)),
        );
      return;
    }
    if (command.type === "cmd.workspace_delete") {
      const payload = workspaceDeletePayloadSchema.safeParse(command.payload);
      if (!payload.success) {
        client.sendResult(command.seq, false, `invalid workspace_delete payload: ${payload.error.message}`);
        return;
      }
      if (!payload.data.removeFiles) {
        // Adopted workspace: Omni never deletes a path it did not create.
        client.sendResult(command.seq, true);
        return;
      }
      void workspaceOps
        .run(async () => {
          if (payload.data.rootPath) await deleteWorkspaceFiles(payload.data.rootPath);
        })
        .then(
          () => client.sendResult(command.seq, true),
          (err) =>
            client.sendResult(command.seq, false, err instanceof Error ? err.message : String(err)),
        );
      return;
    }
    // Fail-ack unknown commands so they are not replayed forever.
    client.sendResult(command.seq, false, `unsupported command: ${command.type}`);
  }

  async function diskFree(): Promise<Partial<Pick<HostStatus, "diskFreeBytes">>> {
    try {
      const stats = await statfs(homedir());
      const bytes = Number(stats.bavail) * Number(stats.bsize);
      return Number.isFinite(bytes) && bytes >= 0 ? { diskFreeBytes: bytes } : {};
    } catch {
      return {}; // statfs unavailable (exotic platform) — omit, schema-optional
    }
  }

  return {
    done,
    stop() {
      stopped = true;
      current?.close();
    },
  };
}
