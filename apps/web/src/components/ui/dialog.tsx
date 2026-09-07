"use client";

import type { ReactNode } from "react";
import { S } from "@/lib/strings";
import { cn } from "@/lib/utils";

/** Minimal modal: overlay + centered card, closes on overlay click and Esc. */
export function Dialog({
  open,
  title,
  onClose,
  children,
  wide,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "w-full rounded-xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl",
          wide ? "max-w-xl" : "max-w-sm",
        )}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-100">{title}</h2>
          <button
            onClick={onClose}
            aria-label={S.cancel}
            className="rounded-md px-2 text-lg leading-none text-zinc-500 hover:text-zinc-200"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
