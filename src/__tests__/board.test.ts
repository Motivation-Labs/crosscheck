import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PRBoard, fmtTokens } from '../lib/board.js'
import type { Config } from '../config/schema.js'
import type { WorkflowStep } from '../lib/workflow.js'

describe('fmtTokens', () => {
  it('returns empty string for undefined', () => {
    expect(fmtTokens(undefined)).toBe('')
  })

  it('formats sub-1K counts as raw number', () => {
    expect(fmtTokens(0)).toBe('(0)')
    expect(fmtTokens(900)).toBe('(900)')
    expect(fmtTokens(999)).toBe('(999)')
  })

  it('formats exactly 1K with no decimal', () => {
    expect(fmtTokens(1000)).toBe('(1K)')
  })

  it('formats 1.2K correctly', () => {
    expect(fmtTokens(1200)).toBe('(1.2K)')
  })

  it('strips trailing .0 from K values', () => {
    expect(fmtTokens(2000)).toBe('(2K)')
    expect(fmtTokens(10000)).toBe('(10K)')
  })

  it('formats fractional K values', () => {
    expect(fmtTokens(1500)).toBe('(1.5K)')
    expect(fmtTokens(99900)).toBe('(99.9K)')
  })

  it('formats exactly 1M with no decimal', () => {
    expect(fmtTokens(1_000_000)).toBe('(1M)')
  })

  it('formats 1.5M correctly', () => {
    expect(fmtTokens(1_500_000)).toBe('(1.5M)')
  })

  it('strips trailing .0 from M values', () => {
    expect(fmtTokens(2_000_000)).toBe('(2M)')
  })
})

// ── PRBoard rendering + retention ───────────────────────────────────────────

const baseConfig = {
  mode: 'crosscheck',
  quality: { tier: 'balanced' },
  vendors: { claude: { enabled: true }, codex: { enabled: false } },
  display: {
    theme: {
      bar_fill: 'blue',
      bar_empty: 'dim',
      cr_approve: 'green',
      cr_needs_work: 'yellow',
      cr_block: 'red',
      fix_fill: 'cyan',
    },
  },
} as unknown as Config

const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, '')

const reviewStep: WorkflowStep = {
  type: 'review',
  name: 'review',
  reviewer: 'auto',
  max_rounds: 1,
}

describe('PRBoard — TTY workspace retention', () => {
  let board: PRBoard
  let originalIsTTY: boolean | undefined
  let originalWrite: typeof process.stdout.write

  beforeEach(() => {
    originalIsTTY = process.stdout.isTTY
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
    originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (() => true) as typeof process.stdout.write
    board = new PRBoard()
    board.setConfig(baseConfig, [reviewStep])
  })

  afterEach(() => {
    board.stop()
    process.stdout.write = originalWrite
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true })
  })

  // Tests reach into private state because the relevant invariants live
  // on the slots map and there is no public read API.
  const slots = () => (board as unknown as { slots: Map<string, unknown> }).slots
  const invokeRender = () => (board as unknown as { render: () => string }).render()
  const invokeFolded = (key: string) =>
    (board as unknown as { renderPRSlotFolded: (s: unknown) => string }).renderPRSlotFolded(slots().get(key))

  it('keeps completed slot in the workspace (no auto-clear)', () => {
    board.addPR('k1', 1, 'a/b', 'main')
    board.completePR('k1', { elapsedMs: 1000, url: 'https://github.com/a/b/pull/1' })
    expect(slots().size).toBe(1)
    expect(slots().has('k1')).toBe(true)
  })

  it('evicts oldest completed slots when total exceeds workspace cap', () => {
    for (let i = 0; i < 30; i++) {
      board.addPR(`k${i}`, i, 'a/b', `branch-${i}`)
      board.completePR(`k${i}`, { elapsedMs: 1000, url: `https://github.com/a/b/pull/${i}` })
    }
    invokeRender()
    expect(slots().size).toBe(25)
    // The 5 oldest should be evicted (0..4); 5..29 retained.
    for (let i = 0; i < 5; i++) expect(slots().has(`k${i}`)).toBe(false)
    for (let i = 5; i < 30; i++) expect(slots().has(`k${i}`)).toBe(true)
  })

  it('never evicts active slots even at overflow', () => {
    for (let i = 0; i < 24; i++) {
      board.addPR(`done-${i}`, i, 'a/b', `branch-${i}`)
      board.completePR(`done-${i}`, { elapsedMs: 1000, url: `url-${i}` })
    }
    for (let i = 0; i < 5; i++) {
      board.addPR(`active-${i}`, 100 + i, 'a/b', `active-${i}`)
    }
    expect(slots().size).toBe(29)
    invokeRender()
    expect(slots().size).toBe(25)
    for (let i = 0; i < 5; i++) {
      expect(slots().has(`active-${i}`)).toBe(true)
    }
  })

  it('renders a folded line with verdict, fix count, recheck and url', () => {
    board.addPR('k1', 142, 'acme/api', 'chore/deps')
    board.updatePR('k1', { verdict: 'APPROVE', commentCount: 0, fixCount: 3, recheckVerdict: 'APPROVE' })
    board.completePR('k1', { elapsedMs: 45_000, url: 'https://github.com/acme/api/pull/142' })

    const folded = stripAnsi(invokeFolded('k1'))
    expect(folded).toContain('#142')
    expect(folded).toContain('acme/api')
    expect(folded).toContain('chore/deps')
    expect(folded).toContain('CR: APPROVE')
    expect(folded).toContain('fix 3')
    expect(folded).toContain('recheck APPROVE')
    expect(folded).toMatch(/\(\d+s\)/)
    expect(folded).toContain('https://github.com/acme/api/pull/142')
  })

  it('renders the PR URL in the expanded completed slot (not just folded)', () => {
    board.addPR('k1', 142, 'acme/api', 'chore/deps')
    board.updatePR('k1', { verdict: 'APPROVE', commentCount: 0 })
    board.completePR('k1', { elapsedMs: 45_000, url: 'https://github.com/acme/api/pull/142' })

    const output = stripAnsi(invokeRender())
    // With a single completed PR (below FOLD_THRESHOLD), the slot stays expanded
    // via renderPRSlot. The URL must still surface so operators can click through.
    expect(output).toContain('https://github.com/acme/api/pull/142')
  })

  it('evicts the prior-round completed slot when round 2 starts for the same PR', () => {
    // Round 1 — BLOCK, fix skipped, recheck skipped (the stale slot the user saw)
    board.addPR('k1@sha1', 214, 'owner/repo', 'fix/branch', 1)
    board.updatePR('k1@sha1', { verdict: 'BLOCK', commentCount: 1, fixCount: 0 })
    board.completePR('k1@sha1', { elapsedMs: 344_000, url: 'https://github.com/owner/repo/pull/214' })
    expect(slots().has('k1@sha1')).toBe(true)

    // Round 2 — new SHA push: board must evict round 1 and add round 2
    board.addPR('k1@sha2', 214, 'owner/repo', 'fix/branch', 2)
    expect(slots().has('k1@sha1')).toBe(false)   // prior round evicted
    expect(slots().has('k1@sha2')).toBe(true)    // new round present

    board.updatePR('k1@sha2', { recheckVerdict: 'APPROVE' })
    board.completePR('k1@sha2', { elapsedMs: 362_000, url: 'https://github.com/owner/repo/pull/214' })

    const output = stripAnsi(invokeRender())
    expect(output).not.toContain('BLOCK')
    expect(output).toContain('APPROVE')
  })

  it('does not evict active slots when round 2 starts', () => {
    // Active round 1 for a different PR — must not be touched
    board.addPR('other@sha', 99, 'owner/repo', 'other-branch', 1)
    // Completed round 1 for PR 214
    board.addPR('k1@sha1', 214, 'owner/repo', 'fix/branch', 1)
    board.completePR('k1@sha1', { elapsedMs: 1_000, url: 'u' })

    board.addPR('k1@sha2', 214, 'owner/repo', 'fix/branch', 2)
    expect(slots().has('other@sha')).toBe(true)   // untouched
    expect(slots().has('k1@sha1')).toBe(false)    // evicted
    expect(slots().has('k1@sha2')).toBe(true)
  })

  it('orders sections top-to-bottom: config → stats → PR workspace', () => {
    board.addPR('k1', 1, 'acme/api', 'feat/x')
    const output = stripAnsi(invokeRender())
    const idxBrand = output.indexOf('crosscheck')
    const idxStats = output.indexOf('PRs:')
    const idxPR = output.indexOf('#1')
    expect(idxBrand).toBeGreaterThanOrEqual(0)
    expect(idxStats).toBeGreaterThan(idxBrand)
    expect(idxPR).toBeGreaterThan(idxStats)
  })
})
