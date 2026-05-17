import { describe, it, expect } from 'vitest'
import { isRetryableFixError, getEffectiveStepType, exceedsMaxRounds } from '../lib/runner.js'

describe('isRetryableFixError', () => {
  it('returns false for auth failure errors', () => {
    expect(isRetryableFixError(new Error('claude auth failure during fix step — run: claude auth login'))).toBe(false)
    expect(isRetryableFixError(new Error('not logged in'))).toBe(false)
    expect(isRetryableFixError(new Error('auth failure: bad credentials'))).toBe(false)
  })

  it('returns true for timeout errors', () => {
    expect(isRetryableFixError(new Error('Command timed out after 180000 milliseconds: claude --print --output-format json'))).toBe(true)
    expect(isRetryableFixError(new Error('spawnSync claude ETIMEDOUT'))).toBe(true)
  })

  it('returns true for subprocess exit errors', () => {
    expect(isRetryableFixError(new Error('Command failed: claude --print --output-format text'))).toBe(true)
  })

  it('returns true for unknown/unexpected errors', () => {
    expect(isRetryableFixError(new Error('something unexpected happened'))).toBe(true)
  })

  it('handles non-Error thrown values', () => {
    expect(isRetryableFixError('timeout string')).toBe(true)
    expect(isRetryableFixError('auth failure: bad token')).toBe(false)
    expect(isRetryableFixError(null)).toBe(true)
  })
})

describe('exceedsMaxRounds', () => {
  it('returns false when round is undefined (no tracking)', () => {
    expect(exceedsMaxRounds('fix', 'fix', 1, undefined)).toBe(false)
    expect(exceedsMaxRounds('recheck', 'recheck', 1, undefined)).toBe(false)
  })

  it('skips fix step when round exceeds max_rounds', () => {
    expect(exceedsMaxRounds('fix', 'fix', 1, 2)).toBe(true)
    expect(exceedsMaxRounds('fix', 'fix', 1, 1)).toBe(false)
    expect(exceedsMaxRounds('fix', 'fix', 2, 2)).toBe(false)
    expect(exceedsMaxRounds('fix', 'fix', 2, 3)).toBe(true)
  })

  it('skips recheck step (from workflow) when round exceeds max_rounds', () => {
    expect(exceedsMaxRounds('recheck', 'recheck', 1, 2)).toBe(true)
    expect(exceedsMaxRounds('recheck', 'recheck', 1, 1)).toBe(false)
  })

  it('never skips a review step coerced to recheck (always runs assessment)', () => {
    expect(exceedsMaxRounds('recheck', 'review', 1, 2)).toBe(false)
    expect(exceedsMaxRounds('recheck', 'review', 1, 99)).toBe(false)
  })

  it('never skips a plain review step', () => {
    expect(exceedsMaxRounds('review', 'review', 1, 2)).toBe(false)
  })
})

describe('getEffectiveStepType', () => {
  it('coerces review → recheck when isRecheckRun is true', () => {
    expect(getEffectiveStepType('review', true)).toBe('recheck')
  })

  it('preserves review when isRecheckRun is false', () => {
    expect(getEffectiveStepType('review', false)).toBe('review')
  })

  it('preserves fix regardless of isRecheckRun', () => {
    expect(getEffectiveStepType('fix', true)).toBe('fix')
    expect(getEffectiveStepType('fix', false)).toBe('fix')
  })

  it('preserves recheck regardless of isRecheckRun', () => {
    expect(getEffectiveStepType('recheck', true)).toBe('recheck')
    expect(getEffectiveStepType('recheck', false)).toBe('recheck')
  })
})
