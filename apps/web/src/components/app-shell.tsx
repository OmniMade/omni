"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { S } from "@/lib/strings";

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      router.replace("/login");
    }
  };

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4">
          <div className="flex items-center gap-6">
            <span className="text-base font-semibold tracking-tight">{S.appName}</span>
            <nav className="flex items-center gap-4 text-sm text-zinc-400">
              <span className="text-zinc-100">{S.hosts}</span>
            </nav>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void logout()}>
            {S.logout}
          </Button>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl px-4 py-6 pb-24">{children}</main>
    </div>
  );
}
