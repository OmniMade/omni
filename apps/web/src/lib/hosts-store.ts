import type { HostSummary, UiServerEvent } from "@omni/aep";
import { create } from "zustand";

export interface HostsState {
  hosts: HostSummary[];
  setAll: (hosts: HostSummary[]) => void;
  applyEvent: (event: UiServerEvent) => void;
}

/**
 * Live host list: seeded from REST, kept current by /api/v1/ws/ui events
 * (host.updated / host.deleted). One store for the whole app.
 */
export const useHostsStore = create<HostsState>((set) => ({
  hosts: [],
  setAll: (hosts) => set({ hosts }),
  applyEvent: (event) =>
    set((state) => {
      if (event.type === "host.deleted") {
        return { hosts: state.hosts.filter((h) => h.id !== event.data.id) };
      }
      if (event.type === "host.updated") {
        const incoming = event.data;
        const exists = state.hosts.some((h) => h.id === incoming.id);
        return {
          hosts: exists
            ? state.hosts.map((h) => (h.id === incoming.id ? incoming : h))
            : [...state.hosts, incoming],
        };
      }
      return state;
    }),
}));
