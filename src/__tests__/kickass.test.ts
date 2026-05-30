import { describe, expect, it } from 'vitest'
import {
  buildKickassRunArgs,
  buildPreflightPlan,
  executeKickassPlan,
  resolveCliInvocation,
  runKickassWithDeps,
  summarizeExecutionResults,
  type KickassDeps,
} from '../commands/kickass.js'
import type { ScanPRStatus as PRStatus, ScanResult } from '../lib/pr-status.js'

function pr(overrides: Partial<PRStatus> = {}): PRStatus {
  const nextAction = overrides.nextAction ?? 'review'
  return {
    owner: 'acme',
    repo: 'web',
    number: 7,
    title: 'PR 7',
    author: 'alice',
    url: 'https://github.com/acme/web/pull/7',
    headSha: 'abc123456789',
    headRef: 'feature',
    headRepo: 'acme/web',
    baseRef: 'main',
    freshness: 'stale',
    reviewState: nextAction === 'recheck' ? 'RECHECK' : 'PR',
    nextAction,
    lastActiveAt: '2026-05-29T00:00:00.000Z',
    staleAfterMs: 60_000,
    ageMs: 120_000,
    verdict: null,
    latestAnnotation: null,
    ...overrides,
  }
}

function scan(prs: PRStatus[]): ScanResult {
  return {
    scannedAt: '2026-05-29T00:00:00.000Z',
    staleAfterMs: 60_000,
    cached: false,
    summary: {
      total: prs.length,
      stale: prs.length,
      not_stale: 0,
      actionable: prs.length,
    },
    prs,
  }
}

describe('buildKickassRunArgs', () => {
  it('targets only review for stale PRs with no prior verdict', () => {
    expect(buildKickassRunArgs(pr({ nextAction: 'review' }))).toEqual([
      'run',
      'https://github.com/acme/web/pull/7',
      '--steps',
      'review',
      '--expected-head-sha',
      'abc123456789',
    ])
  })

  it('targets only fix for stale PRs with unresolved findings', () => {
    expect(buildKickassRunArgs(pr({
      nextAction: 'fix',
      reviewState: 'NEEDS_WORK',
      latestAnnotation: {
        origin: 'claude',
        reviewer: 'codex',
        verdict: 'NEEDS_WORK',
        type: 'review',
        sha: 'abc1234',
      },
    }))).toEqual([
      'run',
      'https://github.com/acme/web/pull/7',
      '--steps',
      'fix',
      '--expected-head-sha',
      'abc123456789',
    ])
  })

  it('targets only recheck for stale PRs after a fix', () => {
    expect(buildKickassRunArgs(pr({ nextAction: 'recheck' }))).toEqual([
      'run',
      'https://github.com/acme/web/pull/7',
      '--steps',
      'recheck',
      '--expected-head-sha',
      'abc123456789',
    ])
  })
})

describe('runKickassWithDeps', () => {
  it('dry-run scans, picks PRs, and prints preflight without mutating', async () => {
    const selected = pr({
      latestAnnotation: {
        origin: 'claude',
        reviewer: 'codex',
        verdict: 'BLOCK',
        type: 'review',
        sha: 'abc1234',
      },
    })
    const calls: string[] = []
    const deps: KickassDeps = {
      loadScanResult: async () => {
        calls.push('scan')
        return scan([selected])
      },
      pickPRs: async (queue) => {
        calls.push(`pick:${queue.length}`)
        return queue
      },
      confirm: async () => {
        calls.push('confirm')
        return true
      },
      dispatchRun: async () => {
        calls.push('dispatch')
      },
      dispatchMerge: async () => {
        calls.push('merge')
      },
      getCurrentHeadSha: async () => {
        calls.push('head')
        return selected.headSha
      },
    }

    await runKickassWithDeps({ dryRun: true, staleAfter: '1m' }, deps)

    expect(calls).toEqual(['scan', 'pick:1'])
  })

  it('skips execution when the PR head changed after scan', async () => {
    const selected = pr({
      nextAction: 'review',
      reviewState: 'PR',
      headSha: 'abc123456789',
    })
    const plan = buildPreflightPlan([selected])
    const dispatched: string[] = []

    const results = await executeKickassPlan(plan, {
      getCurrentHeadSha: async () => 'def987654321',
      dispatchRun: async (item) => {
        dispatched.push(item.pr.url)
      },
      dispatchMerge: async () => {
        dispatched.push('merge')
      },
    })

    expect(dispatched).toEqual([])
    expect(results).toEqual([{
      pr: selected,
      status: 'skipped',
      reason: 'stale_signature',
    }])
  })

  it('downgrades NEEDS_WORK fix to CR when no current-head review comment is usable', () => {
    const selected = pr({
      reviewState: 'NEEDS_WORK',
      nextAction: 'fix',
      latestAnnotation: {
        origin: 'claude',
        reviewer: 'codex',
        verdict: 'NEEDS_WORK',
        type: 'review',
      },
    })

    const plan = buildPreflightPlan([selected])

    expect(plan).toHaveLength(1)
    expect(plan[0].action).toBe('review')
    expect(plan[0].transition).toBe('PR -> CR')
    expect(plan[0].explanation).toBe('no_usable_review_comment')
  })

  it('skips fork fix while allowing fork review and merge actions', async () => {
    const review = pr({
      number: 1,
      nextAction: 'review',
      reviewState: 'PR',
      headRepo: 'fork/web',
    })
    const fix = pr({
      number: 2,
      nextAction: 'fix',
      reviewState: 'BLOCK',
      headRepo: 'fork/web',
      latestAnnotation: {
        origin: 'claude',
        reviewer: 'codex',
        verdict: 'BLOCK',
        type: 'review',
        sha: 'abc1234',
      },
    })
    const merge = pr({
      number: 3,
      nextAction: 'merge',
      reviewState: 'APPROVE',
      headRepo: 'fork/web',
    })
    const plan = buildPreflightPlan([review, fix, merge])
    const dispatched: number[] = []

    const results = await executeKickassPlan(plan, {
      getCurrentHeadSha: async (item) => item.pr.headSha,
      dispatchRun: async (item) => {
        dispatched.push(item.pr.number)
      },
      dispatchMerge: async (item) => {
        dispatched.push(item.pr.number)
      },
    })

    expect(plan.map(item => item.action)).toEqual(['review', 'skip', 'merge'])
    expect(dispatched).toEqual([1, 3])
    expect(results.map(result => result.reason)).toEqual([undefined, 'fork_pr', undefined])
  })

  it('continues executing later PRs when one PR throws', async () => {
    const first = pr({ number: 1, nextAction: 'review' })
    const second = pr({ number: 2, nextAction: 'review' })
    const third = pr({ number: 3, nextAction: 'merge' })
    const dispatched: number[] = []

    const results = await executeKickassPlan(buildPreflightPlan([first, second, third]), {
      getCurrentHeadSha: async (item) => {
        if (item.pr.number === 2) throw new Error('api unavailable')
        return item.pr.headSha
      },
      dispatchRun: async (item) => {
        dispatched.push(item.pr.number)
      },
      dispatchMerge: async (item) => {
        dispatched.push(item.pr.number)
      },
    })

    expect(dispatched).toEqual([1, 3])
    expect(results.map(result => [result.pr.number, result.status, result.reason])).toEqual([
      [1, 'executed', undefined],
      [2, 'failed', 'error'],
      [3, 'executed', undefined],
    ])
  })

  it('summarizes execution outcomes', () => {
    expect(summarizeExecutionResults([
      { pr: pr({ number: 1 }), status: 'executed' },
      { pr: pr({ number: 2 }), status: 'skipped', reason: 'stale_signature' },
      { pr: pr({ number: 3 }), status: 'failed', reason: 'error' },
    ])).toBe('Execution summary: 1 executed, 1 skipped, 1 failed')
  })
})

describe('resolveCliInvocation', () => {
  it('runs built JavaScript through node', () => {
    expect(resolveCliInvocation({
      argvEntry: '/repo/dist/cli.js',
      execPath: '/usr/local/bin/node',
      exists: path => path === '/repo/dist/cli.js',
      urlToPath: url => url.pathname,
    })).toEqual({
      command: '/usr/local/bin/node',
      args: ['/repo/dist/cli.js'],
    })
  })

  it('runs TypeScript CLI entries through the local tsx binary', () => {
    const invocation = resolveCliInvocation({
      argvEntry: '/repo/src/cli.ts',
      execPath: '/usr/local/bin/node',
      exists: path => path === '/repo/src/cli.ts' || path.endsWith('/node_modules/.bin/tsx'),
      urlToPath: url => url.pathname,
    })

    expect(invocation.command.endsWith('/node_modules/.bin/tsx')).toBe(true)
    expect(invocation.args).toEqual(['/repo/src/cli.ts'])
  })

  it('throws when only a TypeScript CLI entry is available without tsx', () => {
    expect(() => resolveCliInvocation({
      argvEntry: '/repo/src/cli.ts',
      execPath: '/usr/local/bin/node',
      exists: path => path === '/repo/src/cli.ts',
      urlToPath: url => url.pathname,
    })).toThrow('Cannot run kickass actions from a TypeScript entrypoint')
  })
})
