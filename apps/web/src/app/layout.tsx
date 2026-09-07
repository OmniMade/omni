import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "./providers";
import { S } from "@/lib/strings";
import "./globals.css";

export const metadata: Metadata = {
  title: `${S.appName} — ${S.tagline}`,
  description: S.tagline,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
