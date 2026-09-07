import type { UiServerEvent, WorkspaceSummary } from "@omni/aep";
import { create } from "zustand";

export interface WorkspacesState {
  workspaces: WorkspaceSummary[];
  setAll: (workspaces: WorkspaceSummary[]) => void;
  applyEvent: (event: UiServerEvent) => void;
}

/**
 * Live workspace list: seeded from REST, kept current by /api/v1/ws/ui events
 * (workspace.updated / workspace.deleted) on the "workspaces" topic.
 */
export const useWorkspacesStore = create<WorkspacesState>((set) => ({
  workspaces: [],
  setAll: (workspaces) => set({ workspaces }),
  applyEvent: (event) =>
    set((state) => {
      if (event.type === "workspace.deleted") {
        return { workspaces: state.workspaces.filter((w) => w.id !== event.data.id) };
      }
      if (event.type === "workspace.updated") {
        const incoming = event.data;
        const exists = state.workspaces.some((w) => w.id === incoming.id);
        return {
          workspaces: exists
            ? state.workspaces.map((w) => (w.id === incoming.id ? incoming : w))
            : [...state.workspaces, incoming],
        };
      }
      return state;
    }),
}));
