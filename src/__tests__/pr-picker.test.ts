import { describe, expect, it } from 'vitest'
import { parseSelection, UserInputError } from '../lib/pr-picker.js'
import type { PRStatus } from '../lib/pr-status.js'

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
    baseRef: 'main',
    freshness: 'stale',
    reviewState: 'PR',
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
