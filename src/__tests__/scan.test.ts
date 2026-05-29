import { describe, expect, it } from 'vitest'
import {
  buildProgressSummary,
  chooseLatestVerdict,
  findScanAnnotations,
  filterScanRowsForOutput,
  mapWithConcurrencyForScan,
  sameGitHubLoginForScan,
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

describe('sameGitHubLoginForScan', () => {
  it('matches configured users case-insensitively', () => {
    expect(sameGitHubLoginForScan('beingzy', 'BeingZY')).toBe(true)
    expect(sameGitHubLoginForScan('alice', 'bob')).toBe(false)
    expect(sameGitHubLoginForScan('alice', null)).toBe(false)
  })
})

describe('scan annotation helpers', () => {
  it('keeps latest annotation metadata separate from latest verdict annotation', () => {
    const annotations = findScanAnnotations([
      {
        id: 1,
        author: 'bot',
        body: '<!-- crosscheck: origin=codex reviewer=claude verdict=NEEDS_WORK type=review -->',
        createdAt: '2026-05-29T10:00:00Z',
        updatedAt: '2026-05-29T10:00:00Z',
      },
      {
        id: 2,
        author: 'bot',
        body: '<!-- crosscheck: type=fix_applied -->',
        createdAt: '2026-05-29T11:00:00Z',
        updatedAt: '2026-05-29T11:00:00Z',
      },
    ])

    expect(annotations.latestAnnotation?.commentId).toBe(2)
    expect(annotations.latestVerdictAnnotation?.commentId).toBe(1)
    expect(annotations.latestVerdictAnnotation?.verdict).toBe('NEEDS_WORK')
  })

  it('uses the latest verdict annotation when logs are absent', () => {
    const verdict = chooseLatestVerdict('NEEDS_WORK', '2026-05-29T10:00:00Z', {
      reviewVerdict: null,
      recheckVerdict: null,
      latestVerdict: null,
      latestVerdictAt: null,
      latestStep: null,
      latestLogAt: null,
      fixAppliedCount: null,
      fixCompletedAt: null,
      skippedReasons: [],
      tokens: { review: 0, fix: 0, recheck: 0, total: 0 },
    })

    expect(verdict).toBe('NEEDS_WORK')
  })

  it('does not infer recheck progress from annotation type', () => {
    const annotation: ScanAnnotationMetadata = {
      commentId: 1,
      commentCreatedAt: '2026-05-29T10:00:00Z',
      raw: 'origin=codex reviewer=claude verdict=APPROVE type=recheck',
      attrs: { origin: 'codex', reviewer: 'claude', verdict: 'APPROVE', type: 'recheck' },
      origin: 'codex',
      reviewer: 'claude',
      verdict: 'APPROVE',
      type: 'recheck',
    }

    expect(buildProgressSummary(annotation, {
      reviewVerdict: null,
      recheckVerdict: null,
      latestVerdict: null,
      latestVerdictAt: null,
      latestStep: null,
      latestLogAt: null,
      fixAppliedCount: null,
      fixCompletedAt: null,
      skippedReasons: [],
      tokens: { review: 0, fix: 0, recheck: 0, total: 0 },
    })).toBe('PR -> CR(APPROVE)')
  })
})

describe('mapWithConcurrencyForScan', () => {
  it('caps concurrent work while preserving result order', async () => {
    let active = 0
    let peak = 0

    const results = await mapWithConcurrencyForScan([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 1))
      active -= 1
      return value * 2
    })

    expect(results).toEqual([2, 4, 6, 8, 10])
    expect(peak).toBeLessThanOrEqual(2)
  })
})
