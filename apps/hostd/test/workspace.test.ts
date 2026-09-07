import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { WorkspaceStatusMessage } from "@omni/aep";
import { dirSizeBytes, parseProgress } from "@omni/hostd/workspace/git";
import {
  adoptWorkspace,
  cloneWorkspace,
  deleteWorkspaceFiles,
  snapshotOf,
  syncWorkspace,
  workspaceTargetPath,
} from "@omni/hostd/workspace/ops";

const exec = promisify(execFile);

/** Run git in a directory (fixture setup only — ops under test use their own runner). */
async function gitIn(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd });
  return stdout;
}

const WS_ID = "018f6b1e-5a1c-7c2e-9f3a-2b6c8d4e0a12";

/** A source repo with one commit on `main` — the "upstream" to clone from. */
async function makeSourceRepo(parent: string): Promise<string> {
  const src = join(parent, "src-repo");
  await mkdir(src, { recursive: true });
  await gitIn(src, "init", "--initial-branch", "main");
  await gitIn(src, "config", "user.email", "test@omni.local");
  await gitIn(src, "config", "user.name", "omni test");
  await writeFile(join(src, "README.md"), "# fixture\n");
  await gitIn(src, "add", ".");
  await gitIn(src, "commit", "-m", "initial");
  return src;
}

/** Record reports; assert helpers read the last of a given status. */
function recorder() {
  const messages: Omit<WorkspaceStatusMessage, "v" | "type">[] = [];
  return {
    messages,
    report: (message: Omit<WorkspaceStatusMessage, "v" | "type">) => void messages.push(message),
    last(status: string) {
      return [...messages].reverse().find((m) => m.status === status);
    },
  };
}

describe("parseProgress", () => {
  it("parses the counting/receiving/resolving phases and ignores other lines", () => {
    expect(parseProgress("Counting objects:  50% (1/2)")).toEqual({ phase: "counting", percent: 50 });
    expect(parseProgress("Receiving objects:  45% (9/20)")).toEqual({ phase: "receiving", percent: 45 });
    expect(parseProgress("Resolving deltas:  10% (1/10)")).toEqual({ phase: "resolving", percent: 10 });
    // Terminal summaries carry no percent; unrelated lines never match.
    expect(parseProgress("Counting objects: 3, done.")).toBeNull();
    expect(parseProgress("Already on 'main'")).toBeNull();
    expect(parseProgress("remote: Enumerating objects: 5, done.")).toBeNull();
  });
});

describe("cloneWorkspace", () => {
  it("clones from a local path and reports ready with a full snapshot", async () => {
    const parent = await mkdtemp(join(tmpdir(), "omni-ws-"));
    try {
      const src = await makeSourceRepo(parent);
      const dataDir = join(parent, "data");
      const rec = recorder();
      await cloneWorkspace({ workspaceId: WS_ID, name: "api", repoUrl: src, dataDir }, rec.report);

      const ready = rec.last("ready");
      expect(ready).toBeTruthy();
      expect(ready!.message).toContain("main");
      expect(ready!.snapshot).toMatchObject({
        rootPath: workspaceTargetPath(dataDir, "api"),
        repoUrl: src,
        defaultBranch: "main",
        branch: "main",
        dirty: false,
      });
      expect(ready!.snapshot!.head).toMatch(/^[0-9a-f]{40}$/);
      expect(ready!.snapshot!.sizeBytes).toBeGreaterThan(0);

      const target = workspaceTargetPath(dataDir, "api");
      expect(await readFile(join(target, "README.md"), "utf8")).toContain("fixture");

      // The first report announced cloning with the target path.
      expect(rec.messages[0]).toMatchObject({ status: "cloning" });
      expect(rec.messages[0]!.snapshot!.rootPath).toBe(target);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("surfaces git's error for a bad URL and cleans up on retry", async () => {
    const parent = await mkdtemp(join(tmpdir(), "omni-ws-"));
    try {
      const dataDir = join(parent, "data");
      const bad = join(parent, "does-not-exist.git");
      const rec = recorder();
      await cloneWorkspace({ workspaceId: WS_ID, name: "bad", repoUrl: bad, dataDir }, rec.report);

      const errored = rec.last("error");
      expect(errored).toBeTruthy();
      expect(errored!.message).toMatch(/does not exist|not found/);

      // A partial directory (as if the daemon died mid-clone) must not break a retry.
      const target = workspaceTargetPath(dataDir, "bad");
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "partial"), "junk");

      const src = await makeSourceRepo(parent);
      const rec2 = recorder();
      await cloneWorkspace({ workspaceId: WS_ID, name: "bad", repoUrl: src, dataDir }, rec2.report);
      expect(rec2.last("ready")!.snapshot!.rootPath).toBe(target);
      expect(rec2.last("ready")!.snapshot!.branch).toBe("main");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("refuses unsafe names as clone targets", () => {
    expect(() => workspaceTargetPath("/data", "../evil")).toThrow(/safe path segment/);
    expect(() => workspaceTargetPath("/data", "a/b")).toThrow(/safe path segment/);
    expect(workspaceTargetPath("/data", "api-2.x")).toBe("/data/workspaces/api-2.x");
  });
});

describe("adoptWorkspace", () => {
  it("adopts an existing clean checkout in place", async () => {
    const parent = await mkdtemp(join(tmpdir(), "omni-ws-"));
    try {
      const src = await makeSourceRepo(parent);
      const checkout = join(parent, "checkout");
      await gitIn(parent, "clone", src, "checkout");

      const rec = recorder();
      await adoptWorkspace({ workspaceId: WS_ID, path: checkout }, rec.report);
      const ready = rec.last("ready");
      expect(ready!.message).toContain("adopted");
      expect(ready!.snapshot).toMatchObject({ rootPath: checkout, branch: "main", dirty: false });
      // Adopted in place: no copy was made anywhere else.
      expect(rec.messages.some((m) => m.snapshot?.rootPath !== checkout)).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("allows a dirty checkout with a warning", async () => {
    const parent = await mkdtemp(join(tmpdir(), "omni-ws-"));
    try {
      const src = await makeSourceRepo(parent);
      const checkout = join(parent, "dirty");
      await gitIn(parent, "clone", src, "dirty");
      await writeFile(join(checkout, "uncommitted.txt"), "local work\n");

      const rec = recorder();
      await adoptWorkspace({ workspaceId: WS_ID, path: checkout }, rec.report);
      const ready = rec.last("ready");
      expect(ready!.kind).toBe("warn");
      expect(ready!.message).toContain("dirty");
      expect(ready!.snapshot!.dirty).toBe(true);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects non-repositories and linked worktrees", async () => {
    const parent = await mkdtemp(join(tmpdir(), "omni-ws-"));
    try {
      const plain = join(parent, "plain");
      await mkdir(plain);

      const rec = recorder();
      await adoptWorkspace({ workspaceId: WS_ID, path: plain }, rec.report);
      expect(rec.last("error")!.message).toContain("not a git repository");

      const src = await makeSourceRepo(parent);
      const checkout = join(parent, "main-co");
      await gitIn(parent, "clone", src, "main-co");
      await gitIn(checkout, "worktree", "add", "../linked-co", "-b", "topic");
      const rec2 = recorder();
      await adoptWorkspace({ workspaceId: WS_ID, path: join(parent, "linked-co") }, rec2.report);
      expect(rec2.last("error")!.message).toContain("linked worktree");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe("syncWorkspace", () => {
  it("fast-forwards after upstream commits and reports the new head", async () => {
    const parent = await mkdtemp(join(tmpdir(), "omni-ws-"));
    try {
      const src = await makeSourceRepo(parent);
      const dataDir = join(parent, "data");
      await cloneWorkspace({ workspaceId: WS_ID, name: "api", repoUrl: src, dataDir }, () => {});
      const target = workspaceTargetPath(dataDir, "api");
      const before = (await snapshotOf(target)).head;

      // Upstream moves: a second commit lands on main.
      await writeFile(join(src, "feature.txt"), "new\n");
      await gitIn(src, "add", ".");
      await gitIn(src, "commit", "-m", "second");

      const rec = recorder();
      await syncWorkspace({ workspaceId: WS_ID, rootPath: target, recordedDefaultBranch: "main" }, rec.report);
      const ready = rec.last("ready");
      expect(ready!.message).toContain("fast-forwarded");
      expect(ready!.snapshot!.head).not.toBe(before);
      expect((await readFile(join(target, "feature.txt"), "utf8")).trim()).toBe("new");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("leaves a dirty checkout untouched and says so", async () => {
    const parent = await mkdtemp(join(tmpdir(), "omni-ws-"));
    try {
      const src = await makeSourceRepo(parent);
      const dataDir = join(parent, "data");
      await cloneWorkspace({ workspaceId: WS_ID, name: "api", repoUrl: src, dataDir }, () => {});
      const target = workspaceTargetPath(dataDir, "api");
      const before = (await snapshotOf(target)).head;

      await writeFile(join(src, "feature.txt"), "new\n");
      await gitIn(src, "add", ".");
      await gitIn(src, "commit", "-m", "second");
      await writeFile(join(target, "local.txt"), "mine\n");

      const rec = recorder();
      await syncWorkspace({ workspaceId: WS_ID, rootPath: target, recordedDefaultBranch: "main" }, rec.report);
      const ready = rec.last("ready");
      expect(ready!.message).toContain("dirty");
      expect(ready!.snapshot!.head).toBe(before);
      expect(ready!.snapshot!.dirty).toBe(true);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("notes an upstream default-branch change in the report", async () => {
    const parent = await mkdtemp(join(tmpdir(), "omni-ws-"));
    try {
      const src = await makeSourceRepo(parent);
      const dataDir = join(parent, "data");
      await cloneWorkspace({ workspaceId: WS_ID, name: "api", repoUrl: src, dataDir }, () => {});
      const target = workspaceTargetPath(dataDir, "api");

      await gitIn(src, "branch", "-m", "main", "trunk");

      const rec = recorder();
      await syncWorkspace({ workspaceId: WS_ID, rootPath: target, recordedDefaultBranch: "main" }, rec.report);
      const ready = rec.last("ready");
      expect(ready!.message).toContain("default branch changed: main → trunk");
      expect(ready!.snapshot!.defaultBranch).toBe("trunk");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("reports a failed fetch without breaking the workspace", async () => {
    const parent = await mkdtemp(join(tmpdir(), "omni-ws-"));
    try {
      const src = await makeSourceRepo(parent);
      const dataDir = join(parent, "data");
      await cloneWorkspace({ workspaceId: WS_ID, name: "api", repoUrl: src, dataDir }, () => {});
      const target = workspaceTargetPath(dataDir, "api");
      const before = (await snapshotOf(target)).head;

      // The origin path disappears — fetch must fail, checkout stays usable.
      await rm(src, { recursive: true, force: true });
      const rec = recorder();
      await syncWorkspace({ workspaceId: WS_ID, rootPath: target, recordedDefaultBranch: "main" }, rec.report);
      const ready = rec.last("ready");
      expect(ready!.kind).toBe("error");
      expect(ready!.message).toBeTruthy();
      expect(ready!.snapshot!.head).toBe(before);
      expect(rec.messages.some((m) => m.status === "syncing")).toBe(true);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe("deleteWorkspaceFiles + dirSizeBytes", () => {
  it("removes the directory tree; size walk sums files", async () => {
    const parent = await mkdtemp(join(tmpdir(), "omni-ws-"));
    try {
      await mkdir(join(parent, "nested"), { recursive: true });
      await writeFile(join(parent, "a.bin"), "12345"); // 5 bytes
      await writeFile(join(parent, "nested", "b.bin"), "1234567"); // 7 bytes
      expect(await dirSizeBytes(parent)).toBe(12);

      await deleteWorkspaceFiles(parent);
      await expect(readFile(join(parent, "a.bin"))).rejects.toMatchObject({ code: "ENOENT" });
      // Deleting a missing path is fine (idempotent replay).
      await expect(deleteWorkspaceFiles(parent)).resolves.toBeUndefined();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
