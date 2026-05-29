import { describe, expect, it } from 'vitest'
import { buildKickassRunArgs, resolveCliInvocation } from '../commands/kickass.js'
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
