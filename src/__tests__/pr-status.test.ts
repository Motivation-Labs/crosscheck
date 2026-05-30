import { describe, expect, it, vi } from 'vitest'
import {
  buildProgressSummary,
  computeLastActive,
  computeTokenTotals,
  foldPRStatus,
  isStale,
  type PRStatusComment,
  type PRStatusLogEvent,
  type PRStatusPullRequest,
} from '../lib/pr-status.js'

const BASE_PR: PRStatusPullRequest = {
  owner: 'acme',
  repo: 'api',
  number: 42,
  title: 'Add scanner',
  author: 'alice',
  headSha: 'abc123',
  headRef: 'feat/scanner',
  headRepo: 'acme/api',
  baseRef: 'main',
  body: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:10:00Z',
}

function comment(body: string, createdAt: string): PRStatusComment {
  return { id: 1, body, createdAt, updatedAt: createdAt }
}

function reviewComment(verdict: 'APPROVE' | 'NEEDS_WORK' | 'BLOCK', createdAt: string, type = 'review'): PRStatusComment {
  return comment(
    `### Code Review by ⚡ Codex\n\nBody\n\n<!-- crosscheck: origin=claude reviewer=codex verdict=${verdict} type=${type} -->`,
    createdAt,
  )
}

describe('foldPRStatus', () => {
  it('returns PR when there is no crosscheck comment', () => {
    const status = foldPRStatus(BASE_PR, [], [])

    expect(status.state).toBe('PR')
    expect(status.nextAction).toBe('review')
    expect(status.verdict).toBeNull()
  })

  it('returns APPROVE from the latest crosscheck annotation', () => {
    const status = foldPRStatus(BASE_PR, [
      reviewComment('NEEDS_WORK', '2026-01-01T01:00:00Z'),
      reviewComment('APPROVE', '2026-01-01T02:00:00Z', 'recheck'),
    ], [])

    expect(status.state).toBe('APPROVE')
    expect(status.nextAction).toBe('none')
    expect(status.verdict).toBe('APPROVE')
  })

  it('returns RECHECK when NEEDS_WORK has a later fix but no later recheck', () => {
    const logs: PRStatusLogEvent[] = [
      {
        ts: '2026-01-01T03:00:00Z',
        level: 'info',
        event: 'fix_complete',
        repo: 'acme/api',
        pr: 42,
        sha: 'def456',
        applied_count: 3,
        tokens_used: 8400,
      },
    ]

    const status = foldPRStatus(BASE_PR, [
      reviewComment('NEEDS_WORK', '2026-01-01T02:00:00Z'),
    ], logs)

    expect(status.state).toBe('RECHECK')
    expect(status.nextAction).toBe('recheck')
    expect(buildProgressSummary(status)).toBe('PR -> CR(NEEDS_WORK) -> Fix(3, 8.4K)')
  })

  it('maps BLOCK to next action fix', () => {
    const status = foldPRStatus(BASE_PR, [
      reviewComment('BLOCK', '2026-01-01T02:00:00Z'),
    ], [])

    expect(status.state).toBe('BLOCK')
    expect(status.nextAction).toBe('fix')
  })

  it('ignores quoted annotations and uses the footer annotation', () => {
    const status = foldPRStatus(BASE_PR, [
      comment(
        [
          'The review text mentions `<!-- crosscheck: origin=claude reviewer=codex verdict=APPROVE type=review -->` as an example.',
          '> <!-- crosscheck: origin=claude reviewer=codex verdict=APPROVE type=review -->',
          '',
          '```',
          '<!-- crosscheck: origin=claude reviewer=codex verdict=APPROVE type=review -->',
          '```',
          '',
          '<!-- crosscheck: origin=claude reviewer=codex verdict=BLOCK type=review -->',
        ].join('\n'),
        '2026-01-01T02:00:00Z',
      ),
    ], [])

    expect(status.state).toBe('BLOCK')
    expect(status.verdict).toBe('BLOCK')
  })

  it('builds a capped progress summary with two fix/recheck rounds', () => {
    const status = foldPRStatus(BASE_PR, [
      reviewComment('NEEDS_WORK', '2026-01-01T01:00:00Z'),
      reviewComment('NEEDS_WORK', '2026-01-01T03:00:00Z', 'recheck'),
      reviewComment('APPROVE', '2026-01-01T05:00:00Z', 'recheck'),
    ], [
      { ts: '2026-01-01T02:00:00Z', level: 'info', event: 'fix_complete', repo: 'acme/api', pr: 42, applied_count: 3, tokens_used: 8400 },
      { ts: '2026-01-01T04:00:00Z', level: 'info', event: 'fix_complete', repo: 'acme/api', pr: 42, applied_count: 1, tokens_used: 1200 },
      { ts: '2026-01-01T06:00:00Z', level: 'info', event: 'fix_complete', repo: 'acme/api', pr: 42, applied_count: 2, tokens_used: 2200 },
    ])

    expect(buildProgressSummary(status)).toBe('PR -> CR(NEEDS_WORK) -> Fix(3, 8.4K) -> Recheck(NEEDS_WORK) -> Fix(1, 1.2K) -> Recheck(APPROVE)')
  })
})

describe('stale activity', () => {
  it('uses the latest activity instead of PR creation time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-10T00:00:00Z'))
    try {
      const pr: PRStatusPullRequest = {
        ...BASE_PR,
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
        commits: [{ sha: 'abc123', committedAt: '2026-01-09T23:00:00Z' }],
      }
      const status = foldPRStatus(pr, [], [])

      expect(computeLastActive(pr, [], []).toISOString()).toBe('2026-01-09T23:00:00.000Z')
      expect(isStale(status, 2 * 60 * 60 * 1000)).toBe(false)
      expect(isStale(status, 30 * 60 * 1000)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('computeTokenTotals', () => {
  it('aggregates review, fix, and recheck tokens per PR and head SHA', () => {
    const totals = computeTokenTotals([
      { ts: '2026-01-01T01:00:00Z', level: 'info', event: 'review_complete', repo: 'acme/api', pr: 42, sha: 'abc123', step_type: 'review', tokens_used: 1000 },
      { ts: '2026-01-01T02:00:00Z', level: 'info', event: 'fix_complete', repo: 'acme/api', pr: 42, sha: 'abc123', tokens_used: 2500 },
      { ts: '2026-01-01T03:00:00Z', level: 'info', event: 'review_complete', repo: 'acme/api', pr: 42, sha: 'abc123', step_type: 'recheck', tokens_used: 1500 },
      { ts: '2026-01-01T04:00:00Z', level: 'info', event: 'review_complete', repo: 'acme/web', pr: 7, tokens_used: 500 },
      { ts: '2026-01-01T05:00:00Z', level: 'info', event: 'fix_complete', repo: 'acme/api', pr: 42 },
    ])

    expect(totals.byPR['acme/api#42']).toEqual({ review: 1000, fix: 2500, recheck: 1500, total: 5000 })
    expect(totals.byPRHeadSha['acme/api#42@abc123']).toEqual({ review: 1000, fix: 2500, recheck: 1500, total: 5000 })
    expect(totals.byPR['acme/web#7']).toEqual({ review: 500, fix: 0, recheck: 0, total: 500 })
  })

  it('counts legacy review_complete logs with type=recheck as recheck tokens', () => {
    const totals = computeTokenTotals([
      { ts: '2026-01-01T01:00:00Z', level: 'info', event: 'review_complete', repo: 'acme/api', pr: 42, sha: 'abc123', type: 'recheck', tokens_used: 700 },
    ])

    expect(totals.byPR['acme/api#42']).toEqual({ review: 0, fix: 0, recheck: 700, total: 700 })
    expect(totals.byPRHeadSha['acme/api#42@abc123']).toEqual({ review: 0, fix: 0, recheck: 700, total: 700 })
  })
})
