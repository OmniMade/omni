"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { AddWorkspaceDialog } from "@/components/workspaces/add-workspace-dialog";
import { WorkspaceRow } from "@/components/workspaces/workspace-row";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useHostsStore } from "@/lib/hosts-store";
import { S } from "@/lib/strings";
import { useWorkspacesStore } from "@/lib/workspaces-store";

const hostStatusTone = { online: "online", offline: "offline", pending: "pending" } as const;
const hostStatusText = { online: S.online, offline: S.offline, pending: S.pending } as const;

/** A host's page: its status plus the workspaces registered on it (F002). */
export default function HostDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [addOpen, setAddOpen] = useState(false);

  const hostsQuery = useQuery({ queryKey: ["hosts"], queryFn: () => api.listHosts() });
  useEffect(() => {
    if (hostsQuery.data) useHostsStore.getState().setAll(hostsQuery.data);
  }, [hostsQuery.data]);
  const host = useHostsStore((s) => s.hosts.find((h) => h.id === id));

  const workspacesQuery = useQuery({
    queryKey: ["workspaces", id],
    queryFn: () => api.listWorkspaces(id),
  });
  useEffect(() => {
    if (workspacesQuery.data) useWorkspacesStore.getState().setAll(workspacesQuery.data);
  }, [workspacesQuery.data]);
  const workspaces = useWorkspacesStore((s) => s.workspaces.filter((w) => w.hostId === id));

  return (
    <AppShell>
      <Link href="/hosts" className="text-sm text-zinc-500 hover:text-zinc-300">
        ← {S.backToHosts}
      </Link>

      <div className="mt-3 flex items-center gap-2">
        <h1 className="truncate text-lg font-semibold">{host?.name ?? id}</h1>
        {host && <Badge tone={hostStatusTone[host.status]}>{hostStatusText[host.status]}</Badge>}
      </div>
      {host && (
        <p className="mt-1 text-xs text-zinc-500">
          {[host.os, host.arch].filter(Boolean).join(" · ") || "—"}
          <span className="mx-1.5">·</span>
          {host.status === "pending" ? S.neverSeen : relativeTime(host.lastSeenAt)}
        </p>
      )}
      {host?.status === "offline" && (
        <p className="mt-2 text-xs text-amber-300/80">{S.hostDetailOffline}</p>
      )}

      <div className="mt-6 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">{S.workspaces}</h2>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          + {S.addWorkspace}
        </Button>
      </div>

      {workspacesQuery.isLoading ? (
        <p className="mt-8 text-sm text-zinc-500">{S.loading}</p>
      ) : workspaces.length === 0 ? (
        <p className="mt-8 text-sm text-zinc-500">{S.noWorkspaces}</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {workspaces.map((workspace) => (
            <WorkspaceRow key={workspace.id} workspace={workspace} />
          ))}
        </ul>
      )}

      <AddWorkspaceDialog hostId={id} open={addOpen} onClose={() => setAddOpen(false)} />
    </AppShell>
  );
}
