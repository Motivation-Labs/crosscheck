// Shared "wait, then retry once at the same timeout" wrapper for reviewer
// subprocesses. The retry exists to absorb transient flakes (API hiccups,
// network blips) — not to silently extend a timeout the user explicitly chose,
// so the second attempt uses the SAME cap as the first.
//
// Behavior:
// - resolvedTimeout === undefined → no cap (e.g. --crazy / --no-timeout): run once, never retry.
// - positive resolvedTimeout → run with that cap. If the run times out, wait
//   retryDelayMs (default 120s) and retry ONCE with the same cap. If the second
//   attempt also times out, rethrow the timeout error (annotated with
//   effectiveTimeoutMs = the original cap) so the caller can report it.
// - non-timeout errors are never retried — they propagate immediately.
//
// Only used by the review/recheck reviewers. fix has its own retry policy and is left alone.

export const DEFAULT_RETRY_DELAY_MS = 120_000

export function isTimeoutError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { timedOut?: boolean }).timedOut === true
}

export interface TimeoutRetryOutcome<T> {
  result: T
  // Present only when the first attempt timed out and the delayed retry succeeded.
  retried?: { timeoutMs: number; delayMs: number }
}

export interface WithTimeoutRetryOptions {
  // Delay between the first timeout and the retry. Defaults to DEFAULT_RETRY_DELAY_MS.
  // Tests pass 0 to skip the wait.
  retryDelayMs?: number
  onRetry?: (timeoutMs: number, delayMs: number) => void
  // Injection point for tests to stub out the actual wait.
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>(resolve => setTimeout(resolve, ms))

export async function withTimeoutRetry<T>(
  resolvedTimeout: number | undefined,
  run: (timeoutMs: number | undefined) => Promise<T>,
  opts: WithTimeoutRetryOptions = {},
): Promise<TimeoutRetryOutcome<T>> {
  if (resolvedTimeout === undefined) {
    return { result: await run(undefined) }
  }

  try {
    return { result: await run(resolvedTimeout) }
  } catch (err: unknown) {
    if (!isTimeoutError(err)) throw err

    const delayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
    opts.onRetry?.(resolvedTimeout, delayMs)
    await (opts.sleep ?? defaultSleep)(delayMs)

    try {
      const result = await run(resolvedTimeout)
      return { result, retried: { timeoutMs: resolvedTimeout, delayMs } }
    } catch (retryErr: unknown) {
      // Tag the original cap so the caller reports the actual budget that was
      // exhausted (twice) in the failure summary it posts to the PR.
      if (isTimeoutError(retryErr) && typeof retryErr === 'object' && retryErr !== null) {
        ;(retryErr as { effectiveTimeoutMs?: number; retryDelayMs?: number }).effectiveTimeoutMs = resolvedTimeout
        ;(retryErr as { effectiveTimeoutMs?: number; retryDelayMs?: number }).retryDelayMs = delayMs
      }
      throw retryErr
    }
  }
}
