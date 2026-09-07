import { S } from "./strings";

export function relativeTime(iso: string | null): string {
  if (!iso) return S.neverSeen;
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return S.justNow;
  if (minutes < 60) return S.minutesAgo(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return S.hoursAgo(hours);
  return new Date(iso).toLocaleString();
}
