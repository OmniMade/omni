import type { WorkspaceSummary } from "@omni/aep";
import { beforeEach, describe, expect, it } from "vitest";
import { useWorkspacesStore } from "../src/lib/workspaces-store";

function workspace(overrides: Partial<WorkspaceSummary> & { id: string }): WorkspaceSummary {
  return {
    hostId: "host-1",
    name: overrides.id.slice(0, 8),
    repoUrl: "https://github.com/me/api.git",
    origin: "cloned",
    rootPath: null,
    defaultBranch: null,
    status: "queued",
    currentBranch: null,
    head: null,
    dirty: null,
    sizeBytes: null,
    error: null,
    lastSyncedAt: null,
    createdAt: "2026-09-07T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  useWorkspacesStore.getState().setAll([]);
});

describe("workspaces store live transitions", () => {
  it("seeds from REST and applies the full clone lifecycle from the UI socket", () => {
    const { setAll, applyEvent } = useWorkspacesStore.getState();
    setAll([workspace({ id: "aaa", name: "api", status: "queued" })]);

    applyEvent({
      type: "workspace.updated",
      data: workspace({ id: "aaa", name: "api", status: "cloning", rootPath: "/h/.omni/workspaces/api" }),
    });
    applyEvent({
      type: "workspace.updated",
      data: workspace({
        id: "aaa",
        name: "api",
        status: "ready",
        rootPath: "/h/.omni/workspaces/api",
        defaultBranch: "main",
        currentBranch: "main",
        head: "abc123def456",
        dirty: false,
        sizeBytes: 4096,
      }),
    });

    const ws = useWorkspacesStore.getState().workspaces;
    expect(ws).toHaveLength(1);
    expect(ws[0]).toMatchObject({ status: "ready", head: "abc123def456", rootPath: "/h/.omni/workspaces/api" });
  });

  it("marks error, then retry restores ready and clears the error", () => {
    const { setAll, applyEvent } = useWorkspacesStore.getState();
    setAll([workspace({ id: "aaa", status: "error", error: "fatal: repository not found" })]);

    applyEvent({
      type: "workspace.updated",
      data: workspace({ id: "aaa", status: "cloning" }),
    });
    applyEvent({
      type: "workspace.updated",
      data: workspace({ id: "aaa", status: "ready", error: null, head: "fff999" }),
    });

    const ws = useWorkspacesStore.getState().workspaces;
    expect(ws[0]!.status).toBe("ready");
    expect(ws[0]!.error).toBeNull();
  });

  it("sync transitions keep the workspace and stamp lastSyncedAt", () => {
    const { setAll, applyEvent } = useWorkspacesStore.getState();
    setAll([workspace({ id: "aaa", status: "ready", head: "111" })]);

    applyEvent({ type: "workspace.updated", data: workspace({ id: "aaa", status: "syncing" }) });
    applyEvent({
      type: "workspace.updated",
      data: workspace({ id: "aaa", status: "ready", head: "222", lastSyncedAt: "2026-09-07T12:00:00.000Z" }),
    });

    const ws = useWorkspacesStore.getState().workspaces;
    expect(ws[0]!.head).toBe("222");
    expect(ws[0]!.lastSyncedAt).toBe("2026-09-07T12:00:00.000Z");
  });

  it("keeps other hosts' workspaces intact and appends unknown ones", () => {
    const { setAll, applyEvent } = useWorkspacesStore.getState();
    setAll([workspace({ id: "aaa", hostId: "host-1", status: "ready" })]);

    applyEvent({
      type: "workspace.updated",
      data: workspace({ id: "bbb", hostId: "host-2", name: "other", status: "queued" }),
    });
    expect(useWorkspacesStore.getState().workspaces.map((w) => w.id)).toEqual(["aaa", "bbb"]);

    applyEvent({ type: "workspace.deleted", data: { id: "aaa" } });
    expect(useWorkspacesStore.getState().workspaces.map((w) => w.id)).toEqual(["bbb"]);
  });

  it("ignores host events entirely", () => {
    const { setAll, applyEvent } = useWorkspacesStore.getState();
    setAll([workspace({ id: "aaa" })]);

    applyEvent({
      type: "host.updated",
      data: {
        id: "host-1",
        name: "macmini",
        status: "online",
        os: "darwin",
        arch: "arm64",
        agent: "omni-hostd/0.1.0",
        hostname: null,
        harnesses: [],
        lastSeenAt: null,
        createdAt: "2026-09-06T00:00:00.000Z",
      },
    });

    expect(useWorkspacesStore.getState().workspaces).toHaveLength(1);
  });
});
