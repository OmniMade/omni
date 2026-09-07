export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  factor?: number;
}

/** Exponential backoff with 50–100 % jitter (see apps/hostd/src/backoff.ts). */
export function backoffDelayMs(
  attempt: number,
  opts: BackoffOptions = {},
  rand: () => number = Math.random,
): number {
  const baseMs = opts.baseMs ?? 1_000;
  const maxMs = opts.maxMs ?? 30_000;
  const factor = opts.factor ?? 2;
  if (attempt < 0) throw new RangeError("attempt must be >= 0");
  const exp = Math.min(maxMs, baseMs * factor ** attempt);
  return Math.round(exp * (0.5 + 0.5 * rand()));
}
