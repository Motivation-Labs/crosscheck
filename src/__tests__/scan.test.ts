import { describe, expect, it } from 'vitest'
import {
  applyLogEntry,
  buildProgressSummary,
  chooseLatestVerdict,
  emptyLogSummary,
  filterScanRowsForOutput,
  findLatestAnnotation,
  selectNextAction,
  type ScanAnnotationMetadata,
  type ScanRow,
} from '../commands/scan.js'

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

describe('scan state helpers', () => {
  it('uses conflict resolve counts in progress summaries', () => {
    const summary = emptyLogSummary()

    applyLogEntry(summary, {
      ts: '2026-05-30T08:00:00Z',
      event: 'conflict_resolve_complete',
      conflicts_resolved: 3,
      tokens_used: 1200,
    })

    expect(summary.fixAppliedCount).toBe(3)
    expect(summary.tokens.fix).toBe(1200)
    expect(buildProgressSummary(null, summary)).toBe('PR -> fix(3)')
  })

  it('does not invent fix(0) for conflict resolve logs without a count', () => {
    const summary = emptyLogSummary()

    applyLogEntry(summary, {
      ts: '2026-05-30T08:00:00Z',
      event: 'conflict_resolve_complete',
    })

    expect(summary.fixAppliedCount).toBeNull()
    expect(buildProgressSummary(null, summary)).toBe('PR')
  })

  it('keeps recheck annotations labeled as rechecks in progress summaries', () => {
    const annotation: ScanAnnotationMetadata = {
      commentId: 1,
      commentCreatedAt: '2026-05-30T08:00:00Z',
      raw: 'origin=codex reviewer=claude verdict=APPROVE type=recheck',
      origin: 'codex',
      reviewer: 'claude',
      verdict: 'APPROVE',
      type: 'recheck',
      isRecheck: true,
    }

    expect(buildProgressSummary(annotation, emptyLogSummary())).toBe('PR -> recheck(APPROVE)')
  })

  it('chooses the newer verdict source', () => {
    const summary = emptyLogSummary()
    summary.latestVerdict = 'BLOCK'
    summary.latestVerdictAt = '2026-05-30T08:00:00Z'

    expect(chooseLatestVerdict('NEEDS_WORK', '2026-05-30T09:00:00Z', summary)).toBe('NEEDS_WORK')
    expect(chooseLatestVerdict('APPROVE', '2026-05-30T07:00:00Z', summary)).toBe('BLOCK')
  })

  it('selects the expected next action for each review state', () => {
    const summary = emptyLogSummary()

    expect(selectNextAction(null, summary)).toBe('next CR')
    expect(selectNextAction('APPROVE', summary)).toBe('next merge')
    expect(selectNextAction('NEEDS_WORK', summary)).toBe('next fix')

    summary.latestStep = 'fix'
    expect(selectNextAction('BLOCK', summary)).toBe('next recheck')
  })

  it('tracks latest annotation separately from latest verdict annotation', () => {
    const annotations = findLatestAnnotation([
      {
        id: 1,
        author: 'bot',
        body: '<!-- crosscheck: origin=codex reviewer=claude verdict=NEEDS_WORK type=review -->',
        createdAt: '2026-05-30T08:00:00Z',
        updatedAt: '2026-05-30T08:00:00Z',
      },
      {
        id: 2,
        author: 'bot',
        body: '<!-- crosscheck: fix_applied -->',
        createdAt: '2026-05-30T09:00:00Z',
        updatedAt: '2026-05-30T09:00:00Z',
      },
    ])

    expect(annotations.latestAnnotation?.commentId).toBe(2)
    expect(annotations.latestVerdictAnnotation?.commentId).toBe(1)
    expect(annotations.latestVerdictAnnotation?.verdict).toBe('NEEDS_WORK')
  })
})
