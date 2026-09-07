"use client";

import { httpToWs } from "@omni/aep";
import { UiSocket } from "@omni/api-client";
import { useHostsStore } from "./hosts-store";
import { useWorkspacesStore } from "./workspaces-store";

let socket: UiSocket | null = null;

/** One UI live-events socket per browser tab, feeding the live stores. */
export function ensureLiveSocket(): UiSocket {
  if (socket) return socket;
  const origin = httpToWs(window.location.origin);
  socket = new UiSocket(`${origin}/api/v1/ws/ui`, (event) => {
    useHostsStore.getState().applyEvent(event);
    useWorkspacesStore.getState().applyEvent(event);
  });
  socket.connect();
  socket.subscribe("hosts");
  socket.subscribe("workspaces");
  return socket;
}
