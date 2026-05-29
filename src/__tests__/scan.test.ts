import { describe, expect, it } from 'vitest'
import { filterScanRowsForOutput, type ScanRow } from '../commands/scan.js'

function row(overrides: Partial<ScanRow>): ScanRow {
  return {
    repo: 'acme/api',
    pr: 1,
    title: 'test PR',
    author: 'alice',
    branch: 'feat/test',
    headSha: 'abcdef123456',
    headShaShort: 'abcdef1',
    url: 'https://github.com/acme/api/pull/1',
    createdAt: '2026-05-29T10:00:00Z',
    lastActiveAt: '2026-05-29T10:00:00Z',
    isStale: false,
    reviewState: 'PR',
    latestVerdict: null,
    progressSummary: 'PR',
    tokens: { review: 0, fix: 0, recheck: 0, total: 0 },
    latestAnnotation: null,
    nextAction: 'next CR',
    ...overrides,
  }
}

describe('filterScanRowsForOutput', () => {
  it('keeps all rows by default', () => {
    const rows = [
      row({ pr: 1, isStale: true, nextAction: 'next fix' }),
      row({ pr: 2, isStale: false, nextAction: 'next CR' }),
      row({ pr: 3, isStale: true, nextAction: null }),
    ]

    expect(filterScanRowsForOutput(rows, false).map(r => r.pr)).toEqual([1, 2, 3])
  })

  it('tidy mode hides non-stale rows and rows without a next action', () => {
    const rows = [
      row({ pr: 1, isStale: true, nextAction: 'next fix' }),
      row({ pr: 2, isStale: false, nextAction: 'next CR' }),
      row({ pr: 3, isStale: true, nextAction: null }),
    ]

    expect(filterScanRowsForOutput(rows, true).map(r => r.pr)).toEqual([1])
  })
})
