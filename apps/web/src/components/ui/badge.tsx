import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type Tone = "online" | "offline" | "pending" | "neutral" | "error";

const tones: Record<Tone, string> = {
  online: "bg-emerald-950/80 text-emerald-300 border-emerald-800/70",
  offline: "bg-zinc-900 text-zinc-400 border-zinc-700",
  pending: "bg-amber-950/70 text-amber-300 border-amber-800/60",
  neutral: "bg-zinc-900 text-zinc-300 border-zinc-700",
  error: "bg-red-950/80 text-red-300 border-red-800/70",
};

export function Badge({ tone, className, children }: { tone: Tone; className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        tones[tone],
        className,
      )}
    >
      {tone === "online" && <span className="size-1.5 rounded-full bg-emerald-400" />}
      {children}
    </span>
  );
}
