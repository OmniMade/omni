"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { WorkspaceSummary } from "@omni/aep";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { formatBytes, relativeTime } from "@/lib/format";
import { S } from "@/lib/strings";
import { cn } from "@/lib/utils";

const statusTone = {
  queued: "pending",
  cloning: "pending",
  adopting: "pending",
  syncing: "pending",
  ready: "online",
  error: "error",
} as const;
const statusText = {
  queued: S.wsQueued,
  cloning: S.wsCloning,
  adopting: S.wsAdopting,
  syncing: S.wsSyncing,
  ready: S.wsReady,
  error: S.wsError,
} as const;
const BUSY: readonly WorkspaceSummary["status"][] = ["queued", "cloning", "adopting", "syncing"];

const kindTone: Record<string, string> = {
  error: "text-red-400",
  warn: "text-amber-300",
  ready: "text-emerald-300",
  sync: "text-sky-300",
  registered: "text-zinc-300",
  progress: "text-zinc-400",
  info: "text-zinc-400",
};

export function WorkspaceRow({ workspace }: { workspace: WorkspaceSummary }) {
  const queryClient = useQueryClient();
  const [logOpen, setLogOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const busy = BUSY.includes(workspace.status);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["workspaces"] });

  const sync = useMutation({
    mutationFn: () => api.syncWorkspace(workspace.id),
    onSettled: invalidate,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteWorkspace(workspace.id),
    onSuccess: () => setDeleteOpen(false),
    onSettled: invalidate,
  });

  return (
    <li className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{workspace.name}</span>
            <Badge tone={statusTone[workspace.status]}>{statusText[workspace.status]}</Badge>
            {workspace.dirty && <Badge tone="error">{S.dirtyBadge}</Badge>}
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            {workspace.currentBranch
              ? S.workspaceMeta(workspace.currentBranch, workspace.head?.slice(0, 8) ?? "—", formatBytes(workspace.sizeBytes))
              : workspace.repoUrl ?? "—"}
            <span className="mx-1.5">·</span>
            {workspace.lastSyncedAt ? S.lastSynced(relativeTime(workspace.lastSyncedAt)) : S.neverSynced}
            {workspace.origin === "adopted" && (
              <>
                <span className="mx-1.5">·</span>
                <span className="text-zinc-600">adopted</span>
              </>
            )}
          </p>
          {workspace.rootPath && <p className="mt-0.5 truncate text-xs text-zinc-600">{workspace.rootPath}</p>}
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || sync.isPending}
            onClick={() => sync.mutate()}
            title={busy ? S.syncBusyHint : undefined}
          >
            {workspace.status === "error" ? S.retry : S.sync}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setLogOpen((v) => !v)}>
            {logOpen ? S.hideActivity : S.activity}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-red-400 hover:bg-red-950/40 hover:text-red-300"
            onClick={() => setDeleteOpen(true)}
          >
            {S.deleteWorkspace}
          </Button>
        </div>
      </div>

      {workspace.error && (
        <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-lg border border-red-900/60 bg-red-950/30 p-2.5 text-xs text-red-300">
          {workspace.error}
        </pre>
      )}
      {sync.error && !workspace.error && (
        <p className="mt-2 text-xs text-red-400">{sync.error instanceof Error ? sync.error.message : S.errorGeneric}</p>
      )}

      {logOpen && <ActivityLog workspaceId={workspace.id} />}

      <DeleteDialog
        open={deleteOpen}
        workspace={workspace}
        busy={remove.isPending}
        error={remove.error instanceof Error ? remove.error.message : null}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => remove.mutate()}
      />
    </li>
  );
}

function ActivityLog({ workspaceId }: { workspaceId: string }) {
  const query = useQuery({
    queryKey: ["workspace-events", workspaceId],
    queryFn: () => api.listWorkspaceEvents(workspaceId),
  });

  if (query.isLoading) return <p className="mt-3 text-xs text-zinc-500">{S.loading}</p>;
  const events = query.data ?? [];
  if (events.length === 0) return <p className="mt-3 text-xs text-zinc-500">{S.noActivity}</p>;

  return (
    <ol className="mt-3 space-y-1.5 border-t border-zinc-800/70 pt-3">
      {events.map((event) => (
        <li key={event.id} className="flex gap-2 text-xs">
          <span className="w-16 shrink-0 tabular-nums text-zinc-600">
            {new Date(event.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </span>
          <span className={cn("min-w-0 break-words", kindTone[event.kind] ?? "text-zinc-400")}>{event.message}</span>
        </li>
      ))}
    </ol>
  );
}

function DeleteDialog({
  open,
  workspace,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean;
  workspace: WorkspaceSummary;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} title={S.deleteWorkspaceTitle} onClose={onClose}>
      <p className="text-sm text-zinc-300">
        {S.deleteWorkspaceWarning(workspace.name, workspace.origin === "cloned")}
      </p>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
      <div className="mt-4 flex gap-2">
        <Button variant="outline" className="flex-1" onClick={onClose}>
          {S.cancel}
        </Button>
        <Button variant="danger" className="flex-1" disabled={busy} onClick={onConfirm}>
          {S.deleteWorkspaceCta}
        </Button>
      </div>
    </Dialog>
  );
}
