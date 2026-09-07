import { mkdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { WorkspaceSnapshot, WorkspaceStatusMessage } from "@omni/aep";
import {
  dirSizeBytes,
  git,
  GitError,
  gitOk,
  parseProgress,
  type GitProgress,
} from "./git";

/** Status sink: the daemon wires this to ChannelClient.sendWorkspaceStatus. */
export type WorkspaceReporter = (message: Omit<WorkspaceStatusMessage, "v" | "type">) => void;

/** `<omni-data>` root: beside hostd.json, overridable for tests / big disks. */
export function defaultDataDir(env: { OMNI_HOSTD_DATA?: string } = process.env): string {
  return env.OMNI_HOSTD_DATA ?? join(homedir(), ".omni");
}

/** Clone targets are `<omni-data>/workspaces/<name>`; the name is a single segment. */
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function workspaceTargetPath(dataDir: string, name: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`workspace name is not a safe path segment: ${JSON.stringify(name)}`);
  }
  return join(dataDir, "workspaces", name);
}

/** Serialize workspace operations: one at a time per host, later ones queue. */
export class OpQueue {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(op: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(op, op);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/** Collect the repo facts reported with ready/idle statuses. */
export async function snapshotOf(rootPath: string): Promise<Required<WorkspaceSnapshot>> {
  const [branch, head, dirty, sizeBytes, defaultBranch, repoUrl] = await Promise.all([
    git(["branch", "--show-current"], { cwd: rootPath }).then((r) => r.stdout.trim() || null),
    git(["rev-parse", "HEAD"], { cwd: rootPath }).then((r) => (r.ok ? r.stdout.trim() : null)),
    git(["status", "--porcelain"], { cwd: rootPath }).then((r) => r.stdout.trim().length > 0),
    dirSizeBytes(rootPath),
    git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: rootPath }).then((r) =>
      r.ok ? r.stdout.trim().replace(/^origin\//, "") : null,
    ),
    git(["remote", "get-url", "origin"], { cwd: rootPath }).then((r) =>
      r.ok ? r.stdout.trim() : null,
    ),
  ]);
  return { rootPath, repoUrl, defaultBranch, branch, head, dirty, sizeBytes };
}

// ---------------------------------------------------------------------------
// Clone
// ---------------------------------------------------------------------------

export async function cloneWorkspace(
  input: { workspaceId: string; name: string; repoUrl: string; dataDir: string },
  report: WorkspaceReporter,
): Promise<void> {
  const target = workspaceTargetPath(input.dataDir, input.name);
  report({
    workspaceId: input.workspaceId,
    status: "cloning",
    message: `cloning ${input.repoUrl} …`,
    snapshot: { rootPath: target },
  });
  try {
    // A retried clone starts clean: any partial directory from a dead attempt
    // (or a re-delivered command after reconnect) is removed first.
    await rm(target, { recursive: true, force: true });
    await mkdir(join(input.dataDir, "workspaces"), { recursive: true });

    let last: GitProgress | null = null;
    const result = await git(["clone", "--progress", input.repoUrl, target], {
      onStderrLine: (line) => {
        const progress = parseProgress(line);
        if (!progress) return;
        // Throttle: report on phase change, every 20 %, and at completion.
        const moved = !last || progress.phase !== last.phase || progress.percent - last.percent >= 20;
        if (moved || progress.percent === 100) {
          last = progress;
          report({
            workspaceId: input.workspaceId,
            status: "cloning",
            message: `${progress.phase} objects ${progress.percent}%`,
          });
        }
      },
    });
    if (!result.ok) throw new GitError(["clone", input.repoUrl, target], result);

    const snapshot = await snapshotOf(target);
    report({
      workspaceId: input.workspaceId,
      status: "ready",
      message: `cloned ${input.repoUrl} (${snapshot.defaultBranch ?? "default branch"} @ ${shortSha(snapshot.head)})`,
      snapshot,
    });
  } catch (err) {
    report({
      workspaceId: input.workspaceId,
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Adopt
// ---------------------------------------------------------------------------

export async function adoptWorkspace(
  input: { workspaceId: string; path: string },
  report: WorkspaceReporter,
): Promise<void> {
  const rootPath = resolve(input.path);
  report({
    workspaceId: input.workspaceId,
    status: "adopting",
    message: `checking ${rootPath} …`,
    snapshot: { rootPath },
  });
  try {
    if (!isAbsolute(input.path)) throw new Error(`adopt path must be absolute: ${input.path}`);
    const stats = await stat(rootPath);
    if (!stats.isDirectory()) throw new Error(`${rootPath} is not a directory`);

    const inside = (await gitOk(["rev-parse", "--is-inside-work-tree"], { cwd: rootPath })).trim();
    if (inside !== "true") throw new Error(`${rootPath} is not a git repository`);
    const gitDir = resolve(rootPath, (await gitOk(["rev-parse", "--git-dir"], { cwd: rootPath })).trim());
    const commonDir = resolve(rootPath, (await gitOk(["rev-parse", "--git-common-dir"], { cwd: rootPath })).trim());
    if (gitDir !== commonDir) {
      throw new Error(`${rootPath} is a linked worktree — register its main checkout instead`);
    }

    const snapshot = await snapshotOf(rootPath);
    const adopted: Omit<WorkspaceStatusMessage, "v" | "type"> = {
      workspaceId: input.workspaceId,
      status: "ready",
      message: snapshot.dirty
        ? `adopted ${rootPath} — checkout is dirty; local changes are left untouched`
        : `adopted ${rootPath}`,
      snapshot,
    };
    if (snapshot.dirty) adopted.kind = "warn";
    report(adopted);
  } catch (err) {
    report({
      workspaceId: input.workspaceId,
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/** `git ls-remote --symref origin HEAD` → the upstream default branch name. */
export async function upstreamDefaultBranch(rootPath: string): Promise<string | null> {
  const result = await git(["ls-remote", "--symref", "origin", "HEAD"], { cwd: rootPath });
  const line = result.stdout.split("\n").find((l) => l.startsWith("ref: refs/heads/"));
  if (!line) return null;
  return line.replace(/^ref: refs\/heads\//, "").split(/\s/)[0]?.trim() || null;
}

export async function syncWorkspace(
  input: { workspaceId: string; rootPath: string; recordedDefaultBranch?: string | null },
  report: WorkspaceReporter,
): Promise<void> {
  const rootPath = resolve(input.rootPath);
  report({ workspaceId: input.workspaceId, status: "syncing", message: "fetching origin …" });
  // A failed fetch leaves the checkout intact: status returns to ready with
  // the error surfaced (the activity log + error column carry it).
  try {
    const remotes = (await gitOk(["remote"], { cwd: rootPath })).trim().split("\n").filter(Boolean);
    if (!remotes.includes("origin")) {
      const snapshot = await snapshotOf(rootPath);
      report({
        workspaceId: input.workspaceId,
        status: "ready",
        kind: "warn",
        message: `no 'origin' remote configured — nothing to fetch`,
        snapshot,
      });
      return;
    }

    const fetch = await git(["fetch", "--prune", "origin"], { cwd: rootPath });
    if (!fetch.ok) throw new GitError(["fetch", "--prune", "origin"], fetch);

    const upstreamDefault = await upstreamDefaultBranch(rootPath);
    const defaultChanged =
      upstreamDefault !== null &&
      input.recordedDefaultBranch !== undefined &&
      input.recordedDefaultBranch !== null &&
      input.recordedDefaultBranch !== upstreamDefault;

    const snapshot = await snapshotOf(rootPath);
    const notes: string[] = [];
    let head = snapshot.head;

    if (
      snapshot.branch !== null &&
      snapshot.branch === (upstreamDefault ?? snapshot.defaultBranch) &&
      !snapshot.dirty
    ) {
      const before = head;
      const merge = await git(["merge", "--ff-only", `origin/${snapshot.branch}`], { cwd: rootPath });
      if (!merge.ok) throw new GitError(["merge", "--ff-only", `origin/${snapshot.branch}`], merge);
      head = (await gitOk(["rev-parse", "HEAD"], { cwd: rootPath })).trim();
      if (head !== before) notes.push(`fast-forwarded to ${shortSha(head)}`);
    } else if (snapshot.dirty) {
      notes.push("checkout is dirty — left on the current commit");
    }

    if (defaultChanged) {
      notes.push(`default branch changed: ${input.recordedDefaultBranch} → ${upstreamDefault}`);
    }

    report({
      workspaceId: input.workspaceId,
      status: "ready",
      message: `fetched origin; ${snapshot.branch ?? "detached"} @ ${shortSha(head)}` + (notes.length ? ` (${notes.join("; ")})` : ""),
      snapshot: { ...snapshot, head, ...(defaultChanged ? { defaultBranch: upstreamDefault } : {}) },
    });
  } catch (err) {
    const snapshot = await safeSnapshot(rootPath);
    report({
      workspaceId: input.workspaceId,
      status: "ready",
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
      ...(snapshot ? { snapshot } : {}),
    });
  }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/** Best-effort on-disk cleanup; never called for adopted workspaces. */
export async function deleteWorkspaceFiles(rootPath: string): Promise<void> {
  await rm(resolve(rootPath), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 8) : "—";
}

async function safeSnapshot(rootPath: string): Promise<WorkspaceSnapshot | undefined> {
  try {
    return await snapshotOf(rootPath);
  } catch {
    return undefined;
  }
}
