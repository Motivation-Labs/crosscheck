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
