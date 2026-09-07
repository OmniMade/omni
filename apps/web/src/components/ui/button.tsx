import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

type Variant = "default" | "outline" | "ghost" | "danger";
type Size = "sm" | "md";

const variantClasses: Record<Variant, string> = {
  default:
    "bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-100/50 disabled:text-zinc-900/50",
  outline:
    "border border-zinc-700 text-zinc-200 hover:border-zinc-500 hover:text-white disabled:opacity-50",
  ghost: "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60",
  danger:
    "bg-red-900/40 text-red-200 border border-red-800/60 hover:bg-red-900/60 hover:text-red-100",
};

const sizeClasses: Record<Size, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-sm",
};

export function Button({
  variant = "default",
  size = "md",
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; children: ReactNode }) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500",
        "disabled:cursor-not-allowed",
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
