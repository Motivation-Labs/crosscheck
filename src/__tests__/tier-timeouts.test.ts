import { describe, it, expect } from 'vitest'
import { TIER_TIMEOUT_MS, DEFAULT_TIER_TIMEOUT_MS, tierTimeoutMs } from '../reviewers/tier-timeouts.js'

describe('tier-timeouts', () => {
  it('maps fast/balanced/thorough to 300/600/1200 seconds', () => {
    expect(TIER_TIMEOUT_MS.fast).toBe(300_000)
    expect(TIER_TIMEOUT_MS.balanced).toBe(600_000)
    expect(TIER_TIMEOUT_MS.thorough).toBe(1_200_000)
  })

  it('tierTimeoutMs returns the per-tier default', () => {
    expect(tierTimeoutMs('fast')).toBe(300_000)
    expect(tierTimeoutMs('balanced')).toBe(600_000)
    expect(tierTimeoutMs('thorough')).toBe(1_200_000)
  })

  it('DEFAULT_TIER_TIMEOUT_MS falls back to balanced (600s)', () => {
    expect(DEFAULT_TIER_TIMEOUT_MS).toBe(600_000)
  })

  it('tierTimeoutMs falls back to the balanced default for unknown tiers', () => {
    // Cast through unknown — guards against future tier additions where a code path
    // forgets to extend the map. Mirrors the `?? DEFAULT_TIER_TIMEOUT_MS` runtime guard.
    expect(tierTimeoutMs('mystery' as unknown as 'balanced')).toBe(DEFAULT_TIER_TIMEOUT_MS)
  })
})
