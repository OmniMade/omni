import type { HostSummary } from "@omni/aep";
import { beforeEach, describe, expect, it } from "vitest";
import { useHostsStore } from "../src/lib/hosts-store";

function host(overrides: Partial<HostSummary> & { id: string }): HostSummary {
  return {
    name: overrides.id.slice(0, 8),
    status: "pending",
    os: "darwin",
    arch: "arm64",
    agent: "omni-hostd/0.1.0",
    hostname: null,
    harnesses: [],
    lastSeenAt: null,
    createdAt: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  useHostsStore.getState().setAll([]);
});

describe("hosts store live transitions", () => {
  it("seeds from REST and upserts online transitions from the UI socket", () => {
    const { setAll, applyEvent } = useHostsStore.getState();
    setAll([host({ id: "aaa", name: "macmini", status: "offline" })]);

    applyEvent({
      type: "host.updated",
      data: host({ id: "aaa", name: "macmini", status: "online", lastSeenAt: "2026-09-06T12:00:00.000Z" }),
    });

    const hosts = useHostsStore.getState().hosts;
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.status).toBe("online");
    expect(hosts[0]?.lastSeenAt).toBe("2026-09-06T12:00:00.000Z");
  });

  it("flips online → offline without touching other hosts", () => {
    const { setAll, applyEvent } = useHostsStore.getState();
    setAll([
      host({ id: "aaa", name: "macmini", status: "online" }),
      host({ id: "bbb", name: "linuxbox", status: "online" }),
    ]);

    applyEvent({ type: "host.updated", data: host({ id: "bbb", name: "linuxbox", status: "offline" }) });

    const hosts = useHostsStore.getState().hosts;
    expect(hosts.map((h) => [h.name, h.status])).toEqual([
      ["macmini", "online"],
      ["linuxbox", "offline"],
    ]);
  });

  it("appends an unknown host instead of dropping the event", () => {
    const { setAll, applyEvent } = useHostsStore.getState();
    setAll([host({ id: "aaa", name: "macmini" })]);

    applyEvent({ type: "host.updated", data: host({ id: "ccc", name: "newbox", status: "online" }) });

    expect(useHostsStore.getState().hosts.map((h) => h.name)).toEqual(["macmini", "newbox"]);
  });

  it("removes deleted hosts", () => {
    const { setAll, applyEvent } = useHostsStore.getState();
    setAll([host({ id: "aaa", name: "macmini" })]);

    applyEvent({ type: "host.deleted", data: { id: "aaa" } });

    expect(useHostsStore.getState().hosts).toEqual([]);
  });
});
