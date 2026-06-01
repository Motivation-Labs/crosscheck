import { describe, expect, it } from 'vitest'
import { formatDuration, parseDuration } from '../lib/durations.js'

describe('parseDuration', () => {
  it('parses seconds, minutes, hours, and days', () => {
    expect(parseDuration('300s')).toBe(300_000)
    expect(parseDuration('300sec')).toBe(300_000)
    expect(parseDuration('30m')).toBe(30 * 60 * 1000)
    expect(parseDuration('5min')).toBe(5 * 60 * 1000)
    expect(parseDuration('5mins')).toBe(5 * 60 * 1000)
    expect(parseDuration('2h')).toBe(2 * 60 * 60 * 1000)
    expect(parseDuration('1d')).toBe(24 * 60 * 60 * 1000)
  })

  it('accepts surrounding whitespace', () => {
    expect(parseDuration('  4h  ')).toBe(4 * 60 * 60 * 1000)
  })

  it('rejects invalid durations', () => {
    expect(() => parseDuration('')).toThrow('Invalid duration')
    expect(() => parseDuration('10')).toThrow('Invalid duration')
    expect(() => parseDuration('1w')).toThrow('Invalid duration')
    expect(() => parseDuration('0m')).toThrow('Invalid duration')
  })
})

describe('formatDuration', () => {
  it('formats common whole units', () => {
    expect(formatDuration(30 * 60 * 1000)).toBe('30m')
    expect(formatDuration(2 * 60 * 60 * 1000)).toBe('2h')
    expect(formatDuration(24 * 60 * 60 * 1000)).toBe('1d')
  })
})
