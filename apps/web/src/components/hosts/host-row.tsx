"use client";

import type { EnrollmentInfo, HostSummary } from "@omni/api-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FieldError, Input, Label } from "@/components/ui/input";
import { api } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { S } from "@/lib/strings";

const statusTone = { online: "online", offline: "offline", pending: "pending" } as const;
const statusText = {
  online: S.online,
  offline: S.offline,
  pending: S.pending,
} as const;

export function HostRow({ host }: { host: HostSummary }) {
  const queryClient = useQueryClient();
  const [renameOpen, setRenameOpen] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["hosts"] });

  const rename = useMutation({
    mutationFn: (name: string) => api.renameHost(host.id, name),
    onSuccess: () => setRenameOpen(false),
    onSettled: invalidate,
  });
  const rotate = useMutation({
    mutationFn: () => api.rotateHostToken(host.id),
    onSettled: invalidate,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteHost(host.id),
    onSuccess: () => setDeleteOpen(false),
    onSettled: invalidate,
  });

  return (
    <li className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{host.name}</span>
            <Badge tone={statusTone[host.status]}>{statusText[host.status]}</Badge>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            {[host.os, host.arch].filter(Boolean).join(" · ") || "—"}
            <span className="mx-1.5">·</span>
            {host.status === "pending" ? S.neverSeen : relativeTime(host.lastSeenAt)}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button variant="ghost" size="sm" onClick={() => setRenameOpen(true)}>
            {S.rename}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setRotateOpen(true)}>
            {S.rotate}
          </Button>
          <Button variant="ghost" size="sm" className="text-red-400 hover:bg-red-950/40 hover:text-red-300" onClick={() => setDeleteOpen(true)}>
            {S.deleteHost}
          </Button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs uppercase tracking-wide text-zinc-600">{S.harnesses}</span>
        {host.harnesses.length === 0 ? (
          <span className="text-xs text-zinc-600">{S.noHarnesses}</span>
        ) : (
          host.harnesses.map((h) => (
            <Badge key={h.id} tone="neutral">
              {h.id} {h.version}
            </Badge>
          ))
        )}
      </div>

      <RenameDialog
        open={renameOpen}
        initialName={host.name}
        busy={rename.isPending}
        error={rename.error instanceof Error ? rename.error.message : null}
        onClose={() => setRenameOpen(false)}
        onSubmit={(name) => rename.mutate(name)}
      />
      <RotateDialog
        open={rotateOpen}
        hostName={host.name}
        busy={rotate.isPending}
        issued={rotate.data?.enrollment ?? null}
        error={rotate.error instanceof Error ? rotate.error.message : null}
        onClose={() => {
          rotate.reset();
          setRotateOpen(false);
        }}
        onConfirm={() => rotate.mutate()}
      />
      <DeleteDialog
        open={deleteOpen}
        hostName={host.name}
        busy={remove.isPending}
        error={remove.error instanceof Error ? remove.error.message : null}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => remove.mutate()}
      />
    </li>
  );
}

function RenameDialog({
  open,
  initialName,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  initialName: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initialName);
  return (
    <Dialog open={open} title={S.renameTitle} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(name.trim());
        }}
      >
        <div>
          <Label htmlFor={`rename-${initialName}`}>{S.hostName}</Label>
          <Input
            id={`rename-${initialName}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}"
            required
            autoFocus
          />
        </div>
        <FieldError message={error} />
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onClose} type="button">
            {S.cancel}
          </Button>
          <Button type="submit" className="flex-1" disabled={busy || !name.trim()}>
            {S.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RotateDialog({
  open,
  hostName,
  busy,
  issued,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean;
  hostName: string;
  busy: boolean;
  issued: EnrollmentInfo | null;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog open={open} title={S.rotateTitle} onClose={onClose} wide>
      {issued ? (
        <div className="space-y-4">
          <p className="text-sm text-zinc-400">{S.enrollInstructions}</p>
          <pre className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-xs leading-relaxed text-emerald-300">
            {issued.command}
          </pre>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => {
                void navigator.clipboard.writeText(issued.command);
                setCopied(true);
              }}
            >
              {copied ? S.copied : S.copyCommand}
            </Button>
            <Button className="flex-1" onClick={onClose}>
              {S.done}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-zinc-300">{S.rotateWarning}</p>
          <FieldError message={error} />
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={onClose}>
              {S.cancel}
            </Button>
            <Button variant="danger" className="flex-1" disabled={busy} onClick={onConfirm}>
              {S.rotateCta}
            </Button>
          </div>
        </div>
      )}
      <span className="hidden">{hostName}</span>
    </Dialog>
  );
}

function DeleteDialog({
  open,
  hostName,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean;
  hostName: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} title={S.deleteTitle} onClose={onClose}>
      <p className="text-sm text-zinc-300">{S.deleteWarning(hostName)}</p>
      <FieldError message={error} />
      <div className="mt-4 flex gap-2">
        <Button variant="outline" className="flex-1" onClick={onClose}>
          {S.cancel}
        </Button>
        <Button variant="danger" className="flex-1" disabled={busy} onClick={onConfirm}>
          {S.deleteCta}
        </Button>
      </div>
    </Dialog>
  );
}
