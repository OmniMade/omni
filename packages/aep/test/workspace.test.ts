import { describe, expect, it } from "vitest";
import {
  hostToServerSchema,
  uiClientMessageSchema,
  uiServerEventSchema,
  workspaceClonePayloadSchema,
  workspaceStatusMessageSchema,
  workspaceSummarySchema,
} from "../src/index";

const UUID = "018f6b1e-5a1c-7c2e-9f3a-2b6c8d4e0a12";

describe("workspaceStatusMessageSchema", () => {
  it("accepts a full report and a bare status transition", () => {
    const full = {
      v: 1,
      type: "workspace.status",
      workspaceId: UUID,
      status: "ready",
      kind: "ready",
      message: "clone complete",
      snapshot: {
        rootPath: "/home/me/.omni/workspaces/api",
        repoUrl: "git@github.com:me/api.git",
        defaultBranch: "main",
        branch: "main",
        head: "abc123",
        dirty: false,
        sizeBytes: 1024,
      },
    };
    expect(workspaceStatusMessageSchema.parse(full)).toEqual(full);

    expect(
      workspaceStatusMessageSchema.parse({
        v: 1,
        type: "workspace.status",
        workspaceId: UUID,
        status: "cloning",
      }),
    ).toEqual({ v: 1, type: "workspace.status", workspaceId: UUID, status: "cloning" });
  });

  it("flows through the host→server union; rejects bad status and bad version", () => {
    expect(
      hostToServerSchema.safeParse({
        v: 1,
        type: "workspace.status",
        workspaceId: UUID,
        status: "syncing",
      }).success,
    ).toBe(true);
    expect(
      hostToServerSchema.safeParse({
        v: 1,
        type: "workspace.status",
        workspaceId: UUID,
        status: "flapping",
      }).success,
    ).toBe(false);
    expect(
      hostToServerSchema.safeParse({
        v: 2,
        type: "workspace.status",
        workspaceId: UUID,
        status: "ready",
      }).success,
    ).toBe(false);
  });

  it("rejects non-uuid workspace ids and negative sizes", () => {
    expect(
      workspaceStatusMessageSchema.safeParse({
        v: 1,
        type: "workspace.status",
        workspaceId: "not-a-uuid",
        status: "ready",
      }).success,
    ).toBe(false);
    expect(
      workspaceStatusMessageSchema.safeParse({
        v: 1,
        type: "workspace.status",
        workspaceId: UUID,
        status: "ready",
        snapshot: { sizeBytes: -1 },
      }).success,
    ).toBe(false);
  });
});

describe("workspaceClonePayloadSchema", () => {
  it("validates clone mode (repoUrl required, path forbidden)", () => {
    expect(
      workspaceClonePayloadSchema.parse({
        workspaceId: UUID,
        name: "api",
        mode: "clone",
        repoUrl: "https://github.com/me/api.git",
      }),
    ).toEqual({
      workspaceId: UUID,
      name: "api",
      mode: "clone",
      repoUrl: "https://github.com/me/api.git",
    });
    expect(
      workspaceClonePayloadSchema.safeParse({
        workspaceId: UUID,
        name: "api",
        mode: "clone",
        repoUrl: "",
      }).success,
    ).toBe(false);
  });

  it("validates adopt mode (path required)", () => {
    expect(
      workspaceClonePayloadSchema.safeParse({
        workspaceId: UUID,
        name: "api",
        mode: "adopt",
      }).success,
    ).toBe(false);
    expect(
      workspaceClonePayloadSchema.parse({
        workspaceId: UUID,
        name: "api",
        mode: "adopt",
        path: "/srv/api",
      }).mode,
    ).toBe("adopt");
  });
});

describe("workspace summary + UI socket", () => {
  it("parses a summary and accepts the workspaces topic", () => {
    const summary = {
      id: UUID,
      hostId: "018f6b1e-5a1c-7c2e-9f3a-2b6c8d4e0b99",
      name: "api",
      repoUrl: "https://github.com/me/api.git",
      origin: "cloned",
      rootPath: "/home/me/.omni/workspaces/api",
      defaultBranch: "main",
      status: "ready",
      currentBranch: "main",
      head: "abc123",
      dirty: false,
      sizeBytes: 2048,
      error: null,
      lastSyncedAt: null,
      createdAt: "2026-09-07T09:00:00.000Z",
    };
    expect(workspaceSummarySchema.parse(summary)).toEqual(summary);

    expect(
      uiClientMessageSchema.parse({ type: "subscribe", topic: "workspaces" }),
    ).toEqual({ type: "subscribe", topic: "workspaces" });

    const event = { type: "workspace.updated", data: summary };
    expect(uiServerEventSchema.parse(event)).toEqual(event);
    expect(
      uiServerEventSchema.parse({ type: "workspace.deleted", data: { id: UUID } }),
    ).toEqual({ type: "workspace.deleted", data: { id: UUID } });
  });
});
