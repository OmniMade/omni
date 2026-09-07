import { spawn } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Thin git runner: everything workspace operations need from git, with stderr
 * streaming for clone progress. Runtime-agnostic (node:child_process), so
 * tests and e2e spawn the same code under Node or Bun.
 */

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly result: GitResult,
  ) {
    const tail = result.stderr.trim().split("\n").slice(-5).join("\n").slice(-500);
    super(`git ${args.join(" ")} failed:\n${tail || "(no stderr)"}`);
    this.name = "GitError";
  }
}

export function git(
  args: string[],
  opts: { cwd?: string; onStderrLine?: (line: string) => void } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let pending = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      if (opts.onStderrLine) {
        // Progress uses \r as well as \n; flush completed lines either way.
        pending += text;
        const parts = pending.split(/\r\n|\r|\n/);
        pending = parts.pop() ?? "";
        for (const line of parts) {
          if (line.trim()) opts.onStderrLine(line.trim());
        }
      }
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => resolve({ ok: code === 0, stdout, stderr }));
  });
}

/** Run git and throw a GitError carrying stderr on failure. */
export async function gitOk(args: string[], opts: { cwd?: string } = {}): Promise<string> {
  const result = await git(args, opts);
  if (!result.ok) throw new GitError(args, result);
  return result.stdout;
}

/**
 * One parsed clone-progress line, e.g. "Receiving objects:  45% (12/27)".
 * Counting/Compressing/Resolving phases carry percent too.
 */
export interface GitProgress {
  phase: "counting" | "compressing" | "receiving" | "resolving";
  percent: number;
}

const PHASES: Record<string, GitProgress["phase"]> = {
  Counting: "counting",
  Compressing: "compressing",
  Receiving: "receiving",
  Resolving: "resolving",
};

export function parseProgress(line: string): GitProgress | null {
  const match = /^(\w+ing)\s+(?:objects|deltas):\s*(\d+)%/.exec(line);
  if (!match) return null;
  const phase = PHASES[match[1]!];
  if (!phase) return null;
  return { phase, percent: Number(match[2]) };
}

/** Portable on-disk size (bytes) of a directory tree; symlinks count their own size. */
export async function dirSizeBytes(root: string): Promise<number> {
  let total = 0;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    const stats = await lstat(full);
    if (stats.isDirectory()) total += await dirSizeBytes(full);
    else total += stats.size;
  }
  return total;
}
