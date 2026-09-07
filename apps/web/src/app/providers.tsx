"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { ensureLiveSocket } from "@/lib/live";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 },
        },
      }),
  );

  useEffect(() => {
    ensureLiveSocket();
  }, []);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
