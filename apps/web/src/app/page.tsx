"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { api } from "@/lib/api";
import { S } from "@/lib/strings";

/** Landing: authenticated → hosts; otherwise → login (setup is linked there). */
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    let cancelled = false;
    void api.me().then((me) => {
      if (!cancelled) router.replace(me ? "/hosts" : "/login");
    });
    return () => {
      cancelled = true;
    };
  }, [router]);

  return <p className="p-8 text-sm text-zinc-500">{S.loading}</p>;
}
