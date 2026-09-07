"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { AddHostDialog } from "@/components/hosts/add-host-dialog";
import { HostRow } from "@/components/hosts/host-row";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useHostsStore } from "@/lib/hosts-store";
import { S } from "@/lib/strings";

export default function HostsPage() {
  const setAll = useHostsStore((s) => s.setAll);
  const hosts = useHostsStore((s) => s.hosts);
  const [addOpen, setAddOpen] = useState(false);
  const queryClient = useQueryClient();

  const query = useQuery({ queryKey: ["hosts"], queryFn: () => api.listHosts() });

  useEffect(() => {
    if (query.data) setAll(query.data);
  }, [query.data, setAll]);

  return (
    <AppShell>
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">{S.hosts}</h1>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          + {S.addHost}
        </Button>
      </div>

      {query.isLoading ? (
        <p className="mt-8 text-sm text-zinc-500">{S.loading}</p>
      ) : hosts.length === 0 ? (
        <p className="mt-8 text-sm text-zinc-500">{S.noHosts}</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {hosts.map((host) => (
            <HostRow key={host.id} host={host} />
          ))}
        </ul>
      )}

      <AddHostDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onEnrolledMeta={() => void queryClient.invalidateQueries({ queryKey: ["hosts"] })}
      />
    </AppShell>
  );
}
