import { describe, it, expect } from 'vitest'
import { isRetryableFixError } from '../lib/runner.js'

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
