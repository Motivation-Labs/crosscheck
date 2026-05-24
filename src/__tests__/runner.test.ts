import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  isRetryableFixError,
  getEffectiveStepType,
  exceedsMaxRounds,
  countCrosscheckCommitsForPR,
} from '../lib/runner.js'

describe('isRetryableFixError', () => {
  it('returns false for auth failure errors', () => {
    expect(isRetryableFixError(new Error('claude auth failure during fix step — run: claude auth login'))).toBe(false)
    expect(isRetryableFixError(new Error('not logged in'))).toBe(false)
    expect(isRetryableFixError(new Error('auth failure: bad credentials'))).toBe(false)
  })

  it('returns true for timeout errors', () => {
    expect(isRetryableFixError(new Error('Command timed out after 180000 milliseconds: claude --print --output-format json'))).toBe(true)
    expect(isRetryableFixError(new Error('spawnSync claude ETIMEDOUT'))).toBe(true)
  })

  it('returns true for subprocess exit errors', () => {
    expect(isRetryableFixError(new Error('Command failed: claude --print --output-format text'))).toBe(true)
  })

  it('returns true for unknown/unexpected errors', () => {
    expect(isRetryableFixError(new Error('something unexpected happened'))).toBe(true)
  })

  it('handles non-Error thrown values', () => {
    expect(isRetryableFixError('timeout string')).toBe(true)
    expect(isRetryableFixError('auth failure: bad token')).toBe(false)
    expect(isRetryableFixError(null)).toBe(true)
  })
})

describe('exceedsMaxRounds', () => {
  it('returns false when round is undefined (no tracking)', () => {
    expect(exceedsMaxRounds('fix', 'fix', 1, undefined)).toBe(false)
    expect(exceedsMaxRounds('recheck', 'recheck', 1, undefined)).toBe(false)
  })

  it('skips fix step when round exceeds max_rounds', () => {
    expect(exceedsMaxRounds('fix', 'fix', 1, 2)).toBe(true)
    expect(exceedsMaxRounds('fix', 'fix', 1, 1)).toBe(false)
    expect(exceedsMaxRounds('fix', 'fix', 2, 2)).toBe(false)
    expect(exceedsMaxRounds('fix', 'fix', 2, 3)).toBe(true)
  })

  it('skips recheck step (from workflow) when round exceeds max_rounds', () => {
    expect(exceedsMaxRounds('recheck', 'recheck', 1, 2)).toBe(true)
    expect(exceedsMaxRounds('recheck', 'recheck', 1, 1)).toBe(false)
  })

  it('never skips a review step coerced to recheck (always runs assessment)', () => {
    expect(exceedsMaxRounds('recheck', 'review', 1, 2)).toBe(false)
    expect(exceedsMaxRounds('recheck', 'review', 1, 99)).toBe(false)
  })

  it('never skips a plain review step', () => {
    expect(exceedsMaxRounds('review', 'review', 1, 2)).toBe(false)
  })
})

describe('countCrosscheckCommitsForPR', () => {
  let tmpDir: string

  // Build a repo with a `base` branch carrying [crosscheck] commits (simulating
  // a long-lived branch like staging) and a `head` branch ahead of it. The
  // count must include only commits unique to head.
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: tmpDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  const commit = (file: string, content: string, message: string): void => {
    writeFileSync(join(tmpDir, file), content)
    git('add', file)
    git('commit', '-m', message)
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-runner-test-'))
    git('init', '-q', '-b', 'base')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    git('config', 'commit.gpgsign', 'false')

    // base branch: 6 [crosscheck] commits from prior merged PRs
    commit('seed.txt', 'seed\n', 'chore: initial')
    for (let i = 0; i < 6; i++) {
      commit(`base${i}.txt`, `b${i}\n`, `[crosscheck] fix from prior PR #${i}`)
    }

    // Promote base into refs/remotes/origin/base so the helper's
    // `origin/<base>..HEAD` range resolves the same way it does in production
    // (clone.ts fetches the base ref into refs/remotes/origin/<base>).
    git('update-ref', 'refs/remotes/origin/base', 'base')

    // head branch ahead of base
    git('checkout', '-q', '-b', 'feature')
  })

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true })
  })

  it('counts only [crosscheck] commits ahead of base (ignores base history)', () => {
    // Two fix commits on this PR — base has 6 prior crosscheck commits we must ignore
    commit('a.txt', 'a\n', '[crosscheck] fix round 1')
    commit('b.txt', 'b\n', '[crosscheck] fix round 2')
    expect(countCrosscheckCommitsForPR(tmpDir, 'base')).toBe(2)
  })

  it('returns 0 when the PR has no crosscheck commits, even if base has many', () => {
    commit('feat.txt', 'feat\n', 'feat: human work only')
    expect(countCrosscheckCommitsForPR(tmpDir, 'base')).toBe(0)
  })

  it('ignores non-crosscheck commits on the PR branch', () => {
    commit('feat.txt', 'feat\n', 'feat: add thing')
    commit('a.txt', 'a\n', '[crosscheck] fix one')
    commit('docs.txt', 'docs\n', 'docs: update readme')
    expect(countCrosscheckCommitsForPR(tmpDir, 'base')).toBe(1)
  })

  it('falls back to full-history count when origin/<base> does not exist (fail closed)', () => {
    // 6 [crosscheck] commits on base + 1 on feature = 7 total in the branch
    // history. If the scoped range fails, we must still see them so the
    // 5-commit cap trips rather than silently passing.
    commit('a.txt', 'a\n', '[crosscheck] fix one')
    expect(countCrosscheckCommitsForPR(tmpDir, 'nonexistent-branch')).toBe(7)
  })

  it('returns 0 only when neither the scoped range nor the full history is readable', () => {
    // Point tmpDir at a non-repo location — both git invocations will fail.
    const nonRepo = mkdtempSync(join(tmpdir(), 'crosscheck-not-a-repo-'))
    try {
      expect(countCrosscheckCommitsForPR(nonRepo, 'main')).toBe(0)
    } finally {
      rmSync(nonRepo, { force: true, recursive: true })
    }
  })
})

describe('getEffectiveStepType', () => {
  it('coerces review → recheck when isRecheckRun is true', () => {
    expect(getEffectiveStepType('review', true)).toBe('recheck')
  })

  it('preserves review when isRecheckRun is false', () => {
    expect(getEffectiveStepType('review', false)).toBe('review')
  })

  it('preserves fix regardless of isRecheckRun', () => {
    expect(getEffectiveStepType('fix', true)).toBe('fix')
    expect(getEffectiveStepType('fix', false)).toBe('fix')
  })

  it('preserves recheck regardless of isRecheckRun', () => {
    expect(getEffectiveStepType('recheck', true)).toBe('recheck')
    expect(getEffectiveStepType('recheck', false)).toBe('recheck')
  })
})
