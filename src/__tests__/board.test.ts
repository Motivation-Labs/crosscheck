import { describe, it, expect } from 'vitest'
import { fmtTokens } from '../lib/board.js'

describe('fmtTokens', () => {
  it('returns empty string for undefined', () => {
    expect(fmtTokens(undefined)).toBe('')
  })

  it('formats sub-1K counts as raw number', () => {
    expect(fmtTokens(0)).toBe('(0)')
    expect(fmtTokens(900)).toBe('(900)')
    expect(fmtTokens(999)).toBe('(999)')
  })

  it('formats exactly 1K with no decimal', () => {
    expect(fmtTokens(1000)).toBe('(1K)')
  })

  it('formats 1.2K correctly', () => {
    expect(fmtTokens(1200)).toBe('(1.2K)')
  })

  it('strips trailing .0 from K values', () => {
    expect(fmtTokens(2000)).toBe('(2K)')
    expect(fmtTokens(10000)).toBe('(10K)')
  })

  it('formats fractional K values', () => {
    expect(fmtTokens(1500)).toBe('(1.5K)')
    expect(fmtTokens(99900)).toBe('(99.9K)')
  })

  it('formats exactly 1M with no decimal', () => {
    expect(fmtTokens(1_000_000)).toBe('(1M)')
  })

  it('formats 1.5M correctly', () => {
    expect(fmtTokens(1_500_000)).toBe('(1.5M)')
  })

  it('strips trailing .0 from M values', () => {
    expect(fmtTokens(2_000_000)).toBe('(2M)')
  })
})
