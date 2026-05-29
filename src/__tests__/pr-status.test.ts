import { describe, expect, it } from 'vitest'
import { derivePRStatus, parseCrosscheckAnnotation, type PRStatusInput } from '../lib/pr-status.js'

const NOW = Date.parse('2026-05-29T12:00:00.000Z')

function input(overrides: Partial<PRStatusInput> = {}): PRStatusInput {
  return {
    owner: 'acme',
    repo: 'web',
    number: 7,
    title: 'Add dashboard',
    author: 'alice',
    url: 'https://github.com/acme/web/pull/7',
    headSha: 'abc123',
    headRef: 'feature',
    baseRef: 'main',
    prUpdatedAt: '2026-05-28T10:00:00.000Z',
    comments: [],
    reviewComments: [],
    commits: [],
    commitStatuses: [],
    checkRuns: [],
    timelineEvents: [],
    logEvents: [],
    ...overrides,
  }
}

describe('parseCrosscheckAnnotation', () => {
  it('parses the last footer annotation and normalizes verdict underscores', () => {
    const annotation = parseCrosscheckAnnotation(
      'quoted <!-- crosscheck: fix_applied -->\n\n<!-- crosscheck: origin=claude reviewer=codex verdict=NEEDS_WORK type=review -->',
    )
    expect(annotation).toEqual({
      marker: 'origin',
      origin: 'claude',
      reviewer: 'codex',
      verdict: 'NEEDS_WORK',
      type: 'review',
    })
  })

  it('parses bare crosscheck markers', () => {
    expect(parseCrosscheckAnnotation('<!-- crosscheck: fix_applied -->')).toEqual({ marker: 'fix_applied' })
  })
})

describe('derivePRStatus', () => {
  it('marks untouched PRs as reviewable PR state', () => {
    const status = derivePRStatus(input(), { nowMs: NOW, staleAfterMs: 24 * 60 * 60 * 1000 })

    expect(status.reviewState).toBe('PR')
    expect(status.freshness).toBe('stale')
    expect(status.nextAction).toBe('review')
  })

  it('uses the latest crosscheck verdict annotation as review state', () => {
    const status = derivePRStatus(input({
      comments: [{
        body: '<!-- crosscheck: origin=claude reviewer=codex verdict=APPROVE type=review -->',
        createdAt: '2026-05-29T11:00:00.000Z',
        updatedAt: '2026-05-29T11:00:00.000Z',
      }],
    }), { nowMs: NOW, staleAfterMs: 24 * 60 * 60 * 1000 })

    expect(status.reviewState).toBe('APPROVE')
    expect(status.nextAction).toBeNull()
    expect(status.freshness).toBe('not_stale')
  })

  it('moves a PR with fix activity after review to RECHECK', () => {
    const status = derivePRStatus(input({
      comments: [{
        body: '<!-- crosscheck: origin=claude reviewer=codex verdict=NEEDS_WORK type=review -->',
        createdAt: '2026-05-27T11:00:00.000Z',
        updatedAt: '2026-05-27T11:00:00.000Z',
      }],
      logEvents: [{
        ts: '2026-05-27T12:00:00.000Z',
        event: 'fix_complete',
        repo: 'acme/web',
        pr: 7,
        applied_count: 2,
      }],
    }), { nowMs: NOW, staleAfterMs: 24 * 60 * 60 * 1000 })

    expect(status.reviewState).toBe('RECHECK')
    expect(status.nextAction).toBe('recheck')
    expect(status.freshness).toBe('stale')
  })

  it('keeps NEEDS_WORK when no fix has landed yet', () => {
    const status = derivePRStatus(input({
      comments: [{
        body: '<!-- crosscheck: origin=claude reviewer=codex verdict=NEEDS_WORK type=review -->',
        createdAt: '2026-05-27T11:00:00.000Z',
        updatedAt: '2026-05-27T11:00:00.000Z',
      }],
    }), { nowMs: NOW, staleAfterMs: 24 * 60 * 60 * 1000 })

    expect(status.reviewState).toBe('NEEDS_WORK')
    expect(status.nextAction).toBe('run')
    expect(status.freshness).toBe('stale')
  })

  it('uses every activity source when computing last active time', () => {
    const status = derivePRStatus(input({
      comments: [{
        body: '<!-- crosscheck: origin=claude reviewer=codex verdict=BLOCK type=review -->',
        createdAt: '2026-05-27T11:00:00.000Z',
        updatedAt: '2026-05-27T11:00:00.000Z',
      }],
      commits: [{ sha: 'def456', committedAt: '2026-05-29T11:55:00.000Z' }],
    }), { nowMs: NOW, staleAfterMs: 30 * 60 * 1000 })

    expect(status.lastActiveAt).toBe('2026-05-29T11:55:00.000Z')
    expect(status.freshness).toBe('not_stale')
  })
})
