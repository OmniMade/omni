"use client";

import { useMutation } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import type { EnrollmentInfo } from "@omni/api-client";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FieldError, Input, Label } from "@/components/ui/input";
import { api } from "@/lib/api";
import { S } from "@/lib/strings";

/**
 * Two-stage dialog: name the host → receive the one-time token with the
 * exact connect command. The token is shown exactly once.
 */
export function AddHostDialog({
  open,
  onClose,
  onEnrolledMeta,
}: {
  open: boolean;
  onClose: () => void;
  onEnrolledMeta: (host: { id: string; name: string }) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ enrollment: EnrollmentInfo; hostId: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const create = useMutation({
    mutationFn: () => api.createHost(name.trim()),
    onSuccess: (result) => {
      setIssued({ enrollment: result.enrollment, hostId: result.host.id });
      onEnrolledMeta({ id: result.host.id, name: result.host.name });
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : S.errorGeneric),
  });

  const close = () => {
    setName("");
    setIssued(null);
    setError(null);
    setCopied(false);
    onClose();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  const copyCommand = async () => {
    if (!issued) return;
    await navigator.clipboard.writeText(issued.enrollment.command);
    setCopied(true);
  };

  return (
    <Dialog open={open} title={issued ? S.addHostTitle : S.addHostTitle} onClose={close}>
      {issued ? (
        <div className="space-y-4">
          <p className="text-sm text-zinc-400">{S.enrollInstructions}</p>
          <pre className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-xs leading-relaxed text-emerald-300">
            {issued.enrollment.command}
          </pre>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => void copyCommand()}>
              {copied ? S.copied : S.copyCommand}
            </Button>
            <Button className="flex-1" onClick={close}>
              {S.done}
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label htmlFor="new-host-name">{S.hostName}</Label>
            <Input
              id="new-host-name"
              placeholder={S.hostNamePlaceholder}
              value={name}
              onChange={(e) => setName(e.target.value)}
              pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}"
              title="Letters, digits, dots, dashes, underscores"
              required
              autoFocus
            />
          </div>
          <FieldError message={error} />
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={close} type="button">
              {S.cancel}
            </Button>
            <Button type="submit" className="flex-1" disabled={create.isPending || !name.trim()}>
              {S.createHost}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
