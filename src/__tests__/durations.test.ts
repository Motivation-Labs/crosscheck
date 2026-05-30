import { describe, expect, it } from 'vitest'
import { formatElapsed, parseDurationMs } from '../lib/durations.js'

describe('parseDurationMs', () => {
  it('parses supported minute, hour, and day durations', () => {
    expect(parseDurationMs('30m')).toBe(30 * 60 * 1000)
    expect(parseDurationMs('2h')).toBe(2 * 60 * 60 * 1000)
    expect(parseDurationMs('1d')).toBe(24 * 60 * 60 * 1000)
  })

  it('rejects invalid duration strings', () => {
    expect(() => parseDurationMs('30')).toThrow(/Invalid duration/)
    expect(() => parseDurationMs('2w')).toThrow(/Invalid duration/)
    expect(() => parseDurationMs('abc')).toThrow(/Invalid duration/)
    expect(() => parseDurationMs('0m')).toThrow(/Invalid duration/)
  })
})

describe('formatElapsed', () => {
  const now = Date.parse('2026-05-29T12:00:00Z')

  it('formats elapsed times consistently', () => {
    expect(formatElapsed('2026-05-29T11:40:00Z', now)).toBe('20m ago')
    expect(formatElapsed('2026-05-28T09:00:00Z', now)).toBe('27h ago')
    expect(formatElapsed('2026-05-26T12:00:00Z', now)).toBe('3d ago')
  })
})
