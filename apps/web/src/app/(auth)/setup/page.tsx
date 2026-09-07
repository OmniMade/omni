"use client";

import { ApiError } from "@omni/api-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label } from "@/components/ui/input";
import { api } from "@/lib/api";
import { S } from "@/lib/strings";

export default function SetupPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [alreadyDone, setAlreadyDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.setup({ username, password });
      router.replace("/hosts");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setAlreadyDone(true);
      } else {
        setError(err instanceof Error ? err.message : S.errorGeneric);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center p-6">
      <h1 className="text-xl font-semibold">{S.setupTitle}</h1>
      <p className="mt-1 text-sm text-zinc-500">{S.setupHint}</p>
      {alreadyDone ? (
        <div className="mt-6 rounded-lg border border-amber-800/60 bg-amber-950/40 p-4 text-sm text-amber-200">
          {S.setupDone}
          <Link href="/login" className="ml-1 underline">
            {S.login}
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-6 space-y-4">
          <div>
            <Label htmlFor="username">{S.username}</Label>
            <Input
              id="username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              minLength={3}
            />
          </div>
          <div>
            <Label htmlFor="password">{S.password}</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
            />
          </div>
          <FieldError message={error} />
          <Button type="submit" disabled={busy || !username || !password} className="w-full">
            {S.setupCta}
          </Button>
        </form>
      )}
    </main>
  );
}
