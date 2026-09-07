"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FieldError, Input, Label } from "@/components/ui/input";
import { api } from "@/lib/api";
import { S } from "@/lib/strings";
import { cn } from "@/lib/utils";

type Mode = "url" | "path";

/**
 * Register a workspace: clone a repo URL onto the host, or adopt an existing
 * on-disk checkout in place. The name defaults to the repo/path name.
 */
export function AddWorkspaceDialog({
  hostId,
  open,
  onClose,
}: {
  hostId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>("url");
  const [repoUrl, setRepoUrl] = useState("");
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const create = useMutation({
    mutationFn: () =>
      api.createWorkspace({
        hostId,
        ...(mode === "url" ? { repoUrl: repoUrl.trim() } : { path: path.trim() }),
        ...(name.trim() ? { name: name.trim() } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      close();
    },
    onError: (err) => setError(err instanceof Error ? err.message : S.errorGeneric),
  });

  const close = () => {
    setMode("url");
    setRepoUrl("");
    setPath("");
    setName("");
    setError(null);
    onClose();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    create.mutate();
  };

  const sourceFilled = mode === "url" ? repoUrl.trim().length > 0 : path.trim().length > 0;

  return (
    <Dialog open={open} title={S.addWorkspaceTitle} onClose={close}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={S.addWorkspaceTitle}>
          {(
            [
              ["url", S.sourceUrlLabel],
              ["path", S.sourcePathLabel],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              onClick={() => setMode(value)}
              className={cn(
                "rounded-lg border px-3 py-2 text-sm transition-colors",
                mode === value
                  ? "border-sky-600 bg-sky-950/40 text-sky-200"
                  : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === "url" ? (
          <div>
            <Label htmlFor="new-ws-url">{S.repoUrl}</Label>
            <Input
              id="new-ws-url"
              placeholder={S.repoUrlPlaceholder}
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              autoFocus
            />
          </div>
        ) : (
          <div>
            <Label htmlFor="new-ws-path">{S.existingPath}</Label>
            <Input
              id="new-ws-path"
              placeholder={S.existingPathPlaceholder}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              autoFocus
            />
            <p className="mt-1.5 text-xs text-zinc-500">{S.existingPathHint}</p>
          </div>
        )}

        <div>
          <Label htmlFor="new-ws-name">{S.workspaceName}</Label>
          <Input
            id="new-ws-name"
            placeholder={S.workspaceNamePlaceholder}
            value={name}
            onChange={(e) => setName(e.target.value)}
            pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}"
            title="Letters, digits, dots, dashes, underscores"
          />
        </div>

        <FieldError message={error} />
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={close} type="button">
            {S.cancel}
          </Button>
          <Button type="submit" className="flex-1" disabled={create.isPending || !sourceFilled}>
            {S.registerWorkspace}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
