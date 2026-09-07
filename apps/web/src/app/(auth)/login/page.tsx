"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label } from "@/components/ui/input";
import { api } from "@/lib/api";
import { S } from "@/lib/strings";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login({ username, password });
      router.replace("/hosts");
    } catch (err) {
      setError(err instanceof Error ? err.message : S.errorGeneric);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center p-6">
      <h1 className="text-xl font-semibold">{S.loginTitle}</h1>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <div>
          <Label htmlFor="username">{S.username}</Label>
          <Input
            id="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </div>
        <div>
          <Label htmlFor="password">{S.password}</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <FieldError message={error} />
        <Button type="submit" disabled={busy || !username || !password} className="w-full">
          {S.login}
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-zinc-500">
        <Link href="/setup" className="underline hover:text-zinc-300">
          {S.firstTime}
        </Link>
      </p>
    </main>
  );
}
