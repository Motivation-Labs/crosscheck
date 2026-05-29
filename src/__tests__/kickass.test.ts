import { describe, expect, it } from 'vitest'
import { buildKickassRunArgs } from '../commands/kickass.js'
import type { PRStatus } from '../lib/pr-status.js'

function pr(nextAction: PRStatus['nextAction']): PRStatus {
  return {
    owner: 'acme',
    repo: 'web',
    number: 7,
    title: 'PR 7',
    author: 'alice',
    url: 'https://github.com/acme/web/pull/7',
    headSha: 'abc123',
    headRef: 'feature',
    baseRef: 'main',
    freshness: 'stale',
    reviewState: nextAction === 'recheck' ? 'RECHECK' : 'NEEDS_WORK',
    nextAction,
    lastActiveAt: '2026-05-29T00:00:00.000Z',
    staleAfterMs: 60_000,
    ageMs: 120_000,
    verdict: null,
    latestAnnotation: null,
  }
}

describe('buildKickassRunArgs', () => {
  it('targets only review for stale PRs with no prior verdict', () => {
    expect(buildKickassRunArgs(pr('review'), false)).toEqual([
      'run',
      'https://github.com/acme/web/pull/7',
      '--steps',
      'review',
    ])
  })

  it('targets only recheck for stale PRs after a fix', () => {
    expect(buildKickassRunArgs(pr('recheck'), true)).toEqual([
      'run',
      'https://github.com/acme/web/pull/7',
      '--steps',
      'recheck',
      '--dry-run',
    ])
  })

  it('runs the full workflow for stale PRs with unresolved findings', () => {
    expect(buildKickassRunArgs(pr('run'), false)).toEqual([
      'run',
      'https://github.com/acme/web/pull/7',
    ])
  })
})
