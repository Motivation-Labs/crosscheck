import { describe, it, expect, vi } from 'vitest'
import { ConfigSchema } from '../config/schema.js'
import {
  buildKickassRunOpts,
  buildKickassPlan,
  executeKickassPlan,
  runKickass,
  type KickassPlanItem,
  type KickassScannedPR,
} from '../commands/kickass.js'

const config = ConfigSchema.parse({
  post_review: { auto_fix: { delivery: { mode: 'commit' } } },
})

function makeScannedPR(overrides: Partial<KickassScannedPR> = {}): KickassScannedPR {
  return {
    owner: 'acme',
    repo: 'api',
    number: 123,
    title: 'Add thing',
    author: 'alice',
    headSha: 'abc1234',
    headRef: 'feat/thing',
    headRepo: 'acme/api',
    baseRef: 'main',
    body: '',
    createdAt: '2026-05-01T00:00:00Z',
    comments: [],
    origin: 'claude',
    reviewer: 'codex',
    ...overrides,
  }
}

describe('runKickass', () => {
  it('dry-run scans, picks, and prints preflight without calling mutators', async () => {
    const selected = buildKickassPlan([makeScannedPR()], config)
    const lines: string[] = []
    const scan = vi.fn(async () => ({ candidates: selected.map(item => item.pr) }))
    const pick = vi.fn(async () => selected)
    const run = vi.fn(async () => {})
    const merge = vi.fn(async () => {})

    const result = await runKickass(
      { dryRun: true },
      {
        config,
        token: 'token',
        scan,
        pick,
        run,
        merge,
        log: line => lines.push(line),
        getCurrentHead: async item => ({ sha: item.scannedHeadSha, headRepo: item.pr.headRepo }),
      },
    )

    expect(result.executed).toBe(0)
    expect(result.skipped).toEqual([{ pr: 'acme/api#123', reason: 'dry_run' }])
    expect(scan).toHaveBeenCalledWith(false)
    expect(pick).toHaveBeenCalledWith(selected)
    expect(run).not.toHaveBeenCalled()
    expect(merge).not.toHaveBeenCalled()
    expect(lines.join('\n')).toContain('PR -> CR')
  })
})

describe('buildKickassPlan', () => {
  it('downgrades NEEDS_WORK -> Fix to PR -> CR when no fresh review comment matches the current head', () => {
    const staleReview = [
      '<!-- crosscheck: origin=claude reviewer=codex verdict=NEEDS_WORK type=review sha=old9999 -->',
    ].join('\n')

    const [item] = buildKickassPlan([
      makeScannedPR({
        comments: [{ id: 10, body: staleReview, createdAt: '2026-05-01T01:00:00Z' }],
      }),
    ], config)

    expect(item.action).toBe('review')
    expect(item.transition).toBe('PR -> CR')
    expect(item.explanation).toContain('no usable review comment')
  })

  it('routes a fix_applied marker to recheck', () => {
    const freshReview = [
      '<!-- crosscheck: origin=claude reviewer=codex verdict=NEEDS_WORK type=review sha=abc1234 -->',
    ].join('\n')
    const fixApplied = '<!-- crosscheck: fix_applied -->'

    const [item] = buildKickassPlan([
      makeScannedPR({
        comments: [
          { id: 10, body: freshReview, createdAt: '2026-05-01T01:00:00Z' },
          { id: 11, body: fixApplied, createdAt: '2026-05-01T02:00:00Z' },
        ],
      }),
    ], config)

    expect(item.action).toBe('recheck')
    expect(item.transition).toBe('FIX -> Recheck')
    expect(item.reviewComment?.id).toBe(10)
  })

  it('downgrades stale APPROVE annotations to review instead of merge', () => {
    const staleApprove = [
      '<!-- crosscheck: origin=claude reviewer=codex verdict=APPROVE type=review sha=old9999 -->',
    ].join('\n')

    const [item] = buildKickassPlan([
      makeScannedPR({
        comments: [{ id: 40, body: staleApprove, createdAt: '2026-05-01T01:00:00Z' }],
      }),
    ], config)

    expect(item.action).toBe('review')
    expect(item.transition).toBe('PR -> CR')
    expect(item.explanation).toContain('old head SHA')
  })
})

describe('buildKickassRunOpts', () => {
  it('passes the kickass config path and expected head SHA through to run', () => {
    const [item] = buildKickassPlan([makeScannedPR()], config)

    expect(buildKickassRunOpts(item, 'review', './custom.yml')).toEqual({
      config: './custom.yml',
      steps: 'review',
      expectedHeadSha: 'abc1234',
    })
  })
})

describe('executeKickassPlan', () => {
  it('skips execution with stale_signature when the PR head changed after scan', async () => {
    const [item] = buildKickassPlan([makeScannedPR()], config)
    const run = vi.fn(async () => {})

    const result = await executeKickassPlan([item], {
      getCurrentHead: async () => ({ sha: 'def5678', headRepo: 'acme/api' }),
      run,
      merge: async () => {},
    })

    expect(result.executed).toBe(0)
    expect(result.skipped).toEqual([{ pr: 'acme/api#123', reason: 'stale_signature' }])
    expect(run).not.toHaveBeenCalled()
  })

  it('allows fork PR review but skips fork fix and merge actions', async () => {
    const forkReview = buildKickassPlan([
      makeScannedPR({ number: 1, headRepo: 'alice/api-fork' }),
    ], config)[0]

    const freshNeedsWork = [
      '### Code Review by ⚡ Codex',
      '<!-- crosscheck: origin=claude reviewer=codex verdict=NEEDS_WORK type=review sha=abc1234 -->',
    ].join('\n\n')
    const forkFix = buildKickassPlan([
      makeScannedPR({
        number: 2,
        headRepo: 'alice/api-fork',
        comments: [{ id: 20, body: freshNeedsWork, createdAt: '2026-05-01T01:00:00Z' }],
      }),
    ], config)[0]

    const approve = [
      '<!-- crosscheck: origin=claude reviewer=codex verdict=APPROVE type=review sha=abc1234 -->',
    ].join('\n')
    const forkMerge = buildKickassPlan([
      makeScannedPR({
        number: 3,
        headRepo: 'alice/api-fork',
        comments: [{ id: 30, body: approve, createdAt: '2026-05-01T02:00:00Z' }],
      }),
    ], config)[0]

    const items: KickassPlanItem[] = [forkReview, forkFix, forkMerge]
    const run = vi.fn(async () => {})
    const merge = vi.fn(async () => {})

    const result = await executeKickassPlan(items, {
      getCurrentHead: async item => ({ sha: item.scannedHeadSha, headRepo: item.pr.headRepo }),
      run,
      merge,
    })

    expect(result.executed).toBe(1)
    expect(run).toHaveBeenCalledWith(forkReview, 'review')
    expect(merge).not.toHaveBeenCalled()
    expect(result.skipped).toEqual([
      { pr: 'acme/api#2', reason: 'fork_pr' },
      { pr: 'acme/api#3', reason: 'fork_pr' },
    ])
  })

  it('skips direct fix and merge when the current head repo is unavailable', async () => {
    const freshNeedsWork = [
      '<!-- crosscheck: origin=claude reviewer=codex verdict=NEEDS_WORK type=review sha=abc1234 -->',
    ].join('\n')
    const fixItem = buildKickassPlan([
      makeScannedPR({
        comments: [{ id: 20, body: freshNeedsWork, createdAt: '2026-05-01T01:00:00Z' }],
      }),
    ], config)[0]
    const approve = [
      '<!-- crosscheck: origin=claude reviewer=codex verdict=APPROVE type=review sha=abc1234 -->',
    ].join('\n')
    const mergeItem = buildKickassPlan([
      makeScannedPR({
        number: 124,
        comments: [{ id: 30, body: approve, createdAt: '2026-05-01T02:00:00Z' }],
      }),
    ], config)[0]
    const run = vi.fn(async () => {})
    const merge = vi.fn(async () => {})

    const result = await executeKickassPlan([fixItem, mergeItem], {
      getCurrentHead: async item => ({ sha: item.scannedHeadSha, headRepo: null }),
      run,
      merge,
    })

    expect(result.executed).toBe(0)
    expect(run).not.toHaveBeenCalled()
    expect(merge).not.toHaveBeenCalled()
    expect(result.skipped).toEqual([
      { pr: 'acme/api#123', reason: 'fork_pr' },
      { pr: 'acme/api#124', reason: 'fork_pr' },
    ])
  })
})
