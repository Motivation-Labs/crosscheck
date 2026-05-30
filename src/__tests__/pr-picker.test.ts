import { describe, expect, it } from 'vitest'
import { actionGroupLabel, formatPickerLabel, parseSelection, sortPRsForPicker, UserInputError } from '../lib/pr-picker.js'
import type { ScanPRStatus as PRStatus } from '../lib/pr-status.js'

function pr(number: number): PRStatus {
  return {
    owner: 'acme',
    repo: 'web',
    number,
    title: `PR ${number}`,
    author: 'alice',
    url: `https://github.com/acme/web/pull/${number}`,
    headSha: 'abc123',
    headRef: 'feature',
    headRepo: 'acme/web',
    baseRef: 'main',
    freshness: 'stale',
    reviewState: 'NEEDS_REVIEW',
    nextAction: 'review',
    lastActiveAt: '2026-05-29T00:00:00.000Z',
    staleAfterMs: 60_000,
    ageMs: 120_000,
    verdict: null,
    latestAnnotation: null,
  }
}

describe('parseSelection', () => {
  const prs = [pr(1), pr(2), pr(3)]

  it('selects all PRs', () => {
    expect(parseSelection('all', prs).map(item => item.number)).toEqual([1, 2, 3])
  })

  it('selects comma-separated PR indexes in operator order', () => {
    expect(parseSelection('3,1,1', prs).map(item => item.number)).toEqual([3, 1])
  })

  it('returns an empty selection for blank input', () => {
    expect(parseSelection('  ', prs)).toEqual([])
  })

  it('rejects out-of-range selections', () => {
    expect(() => parseSelection('4', prs)).toThrow('Invalid selection')
    expect(() => parseSelection('4', prs)).toThrow(UserInputError)
  })
})

describe('picker grouping', () => {
  it('orders actionable PRs by next action group', () => {
    const ordered = sortPRsForPicker([
      { ...pr(4), nextAction: 'merge', reviewState: 'APPROVE' },
      { ...pr(2), nextAction: 'fix', reviewState: 'NEEDS_FIX' },
      { ...pr(3), nextAction: 'recheck', reviewState: 'NEEDS_RECHECK' },
      { ...pr(1), nextAction: 'review', reviewState: 'NEEDS_REVIEW' },
    ])

    expect(ordered.map(item => item.number)).toEqual([1, 2, 3, 4])
    expect(ordered.map(actionGroupLabel)).toEqual(['CR', 'fix', 'recheck', 'merge'])
  })

  it('renders compact labels with action group and scanned head', () => {
    expect(formatPickerLabel(pr(12))).toContain('CR')
    expect(formatPickerLabel(pr(12))).toContain('acme/web#12@abc123')
  })
})
