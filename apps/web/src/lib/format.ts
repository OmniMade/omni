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

export function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
