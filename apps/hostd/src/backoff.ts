export interface BackoffOptions {
  /** Delay for the first retry. Default 1 s. */
  baseMs?: number;
  /** Ceiling for the exponential part. Default 30 s. */
  maxMs?: number;
  /** Growth per consecutive failure. Default 2. */
  factor?: number;
}

/**
 * Exponential backoff with 50–100 % jitter: a uniform random slice of the
 * exponential delay, so reconnecting herds don't stampede in lockstep.
 *
 * `attempt` is the number of consecutive failures so far (first retry = 0).
 */
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

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
