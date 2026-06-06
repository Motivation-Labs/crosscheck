import { describe, it, expect } from 'vitest'
import { withTimeoutRetry, isTimeoutError, DEFAULT_RETRY_DELAY_MS } from '../lib/with-timeout-retry.js'

function timeoutError(): Error & { timedOut: true } {
  return Object.assign(new Error('Command timed out'), { timedOut: true as const })
}

// Sleep stub that records the requested delay so tests don't actually wait.
function captureSleep() {
  const waited: number[] = []
  return { waited, sleep: (ms: number) => { waited.push(ms); return Promise.resolve() } }
}

describe('isTimeoutError', () => {
  it('is true only when timedOut === true', () => {
    expect(isTimeoutError(timeoutError())).toBe(true)
    expect(isTimeoutError(Object.assign(new Error('x'), { timedOut: false }))).toBe(false)
    expect(isTimeoutError(new Error('plain'))).toBe(false)
    expect(isTimeoutError(null)).toBe(false)
    expect(isTimeoutError('timed out')).toBe(false)
  })
})

describe('DEFAULT_RETRY_DELAY_MS', () => {
  it('defaults to 120s — matches the design choice for transient-blip recovery', () => {
    expect(DEFAULT_RETRY_DELAY_MS).toBe(120_000)
  })
})

describe('withTimeoutRetry', () => {
  it('runs once with no cap and never retries when resolvedTimeout is undefined', async () => {
    const calls: (number | undefined)[] = []
    const { waited, sleep } = captureSleep()
    const out = await withTimeoutRetry(undefined, (t) => { calls.push(t); return Promise.resolve('ok') }, { sleep })
    expect(out.result).toBe('ok')
    expect(out.retried).toBeUndefined()
    expect(calls).toEqual([undefined])
    expect(waited).toEqual([])
  })

  it('returns first-attempt result without retry metadata on success', async () => {
    const calls: (number | undefined)[] = []
    const { waited, sleep } = captureSleep()
    const out = await withTimeoutRetry(1000, (t) => { calls.push(t); return Promise.resolve('ok') }, { sleep })
    expect(out.result).toBe('ok')
    expect(out.retried).toBeUndefined()
    expect(calls).toEqual([1000])
    expect(waited).toEqual([])
  })

  it('retries once with the SAME timeout after a delay and reports retried metadata when the retry succeeds', async () => {
    const calls: (number | undefined)[] = []
    const { waited, sleep } = captureSleep()
    let attempt = 0
    const out = await withTimeoutRetry(1000, (t) => {
      calls.push(t)
      attempt += 1
      if (attempt === 1) return Promise.reject(timeoutError())
      return Promise.resolve('ok-on-retry')
    }, { retryDelayMs: 500, sleep })
    expect(out.result).toBe('ok-on-retry')
    expect(out.retried).toEqual({ timeoutMs: 1000, delayMs: 500 })
    // SAME timeout used both times — not doubled.
    expect(calls).toEqual([1000, 1000])
    expect(waited).toEqual([500])
  })

  it('honors the default retry delay when retryDelayMs is not provided', async () => {
    const { waited, sleep } = captureSleep()
    let attempt = 0
    await withTimeoutRetry(1000, () => {
      attempt += 1
      return attempt === 1 ? Promise.reject(timeoutError()) : Promise.resolve('ok')
    }, { sleep })
    expect(waited).toEqual([DEFAULT_RETRY_DELAY_MS])
  })

  it('rethrows with effectiveTimeoutMs and retryDelayMs set when both attempts time out', async () => {
    const { sleep } = captureSleep()
    let caught: unknown
    try {
      await withTimeoutRetry(1500, () => Promise.reject(timeoutError()), { retryDelayMs: 250, sleep })
    } catch (err) {
      caught = err
    }
    expect(isTimeoutError(caught)).toBe(true)
    // effectiveTimeoutMs is the original cap (not doubled).
    expect((caught as { effectiveTimeoutMs?: number }).effectiveTimeoutMs).toBe(1500)
    expect((caught as { retryDelayMs?: number }).retryDelayMs).toBe(250)
  })

  it('does not retry non-timeout errors and does not wait', async () => {
    const calls: (number | undefined)[] = []
    const { waited, sleep } = captureSleep()
    let caught: unknown
    try {
      await withTimeoutRetry(1000, (t) => { calls.push(t); return Promise.reject(new Error('boom')) }, { sleep })
    } catch (err) {
      caught = err
    }
    expect((caught as Error).message).toBe('boom')
    expect(calls).toEqual([1000])
    expect(waited).toEqual([])
  })

  it('invokes onRetry with the timeout and delay before waiting', async () => {
    const seen: Array<[number, number]> = []
    const { sleep } = captureSleep()
    let attempt = 0
    await withTimeoutRetry(2000, () => {
      attempt += 1
      return attempt === 1 ? Promise.reject(timeoutError()) : Promise.resolve('ok')
    }, {
      retryDelayMs: 100,
      sleep,
      onRetry: (timeoutMs, delayMs) => seen.push([timeoutMs, delayMs]),
    })
    expect(seen).toEqual([[2000, 100]])
  })
})
