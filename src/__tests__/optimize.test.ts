import { describe, it, expect } from 'vitest'
import { selectOptimizeAgent } from '../commands/optimize.js'
import type { Config } from '../config/schema.js'
import type { DiagnoseReport } from '../commands/diagnose.js'

function makeConfig(claudeEnabled: boolean, codexEnabled: boolean): Config {
  return {
    mode: 'cross-vendor',
    orgs: [],
    repos: [],
    routing: { codex_reviews_patterns: [], claude_reviews_patterns: [] },
    server: { port: 7892, webhook_path: '/webhook' },
    quality: { tier: 'balanced', focus: [], custom_prompt: undefined },
    budget: { codex_monthly_usd: null, per_review_usd: 1 },
    vendors: {
      claude: { enabled: claudeEnabled, auth: 'subscription', effort: 'medium' },
      codex: { enabled: codexEnabled, auth: 'subscription', effort: 'medium' },
    },
    logs: { enabled: false, retention_days: 7 },
  }
}

function makeReport(
  claudeAttempts = 0, claudeSuccesses = 0,
  codexAttempts = 0, codexSuccesses = 0,
): DiagnoseReport {
  const performance: Record<string, { attempts: number; successes: number; failure_rate: number }> = {}
  if (claudeAttempts > 0) {
    performance['claude'] = {
      attempts: claudeAttempts,
      successes: claudeSuccesses,
      failure_rate: (claudeAttempts - claudeSuccesses) / claudeAttempts,
    }
  }
  if (codexAttempts > 0) {
    performance['codex'] = {
      attempts: codexAttempts,
      successes: codexSuccesses,
      failure_rate: (codexAttempts - codexSuccesses) / codexAttempts,
    }
  }
  return {
    period: { from: 'N/A', to: 'N/A', log_files: 0 },
    summary: { total_reviews: 0, successful: 0, failed: 0, failure_rate: 0 },
    errors: [],
    verdict_distribution: { APPROVE: 0, NEEDS_WORK: 0, BLOCK: 0 },
    repos_seen: [],
    languages_detected: [],
    reviewer_performance: performance,
    suggestions: [],
  }
}

describe('selectOptimizeAgent', () => {
  it('returns codex when only codex is enabled', () => {
    const { agent } = selectOptimizeAgent(makeConfig(false, true), makeReport())
    expect(agent).toBe('codex')
  })

  it('returns claude when only claude is enabled', () => {
    const { agent } = selectOptimizeAgent(makeConfig(true, false), makeReport())
    expect(agent).toBe('claude')
  })

  it('returns claude as default when both enabled and no log data', () => {
    const { agent, reason } = selectOptimizeAgent(makeConfig(true, true), makeReport())
    expect(agent).toBe('claude')
    expect(reason).toMatch(/default/)
  })

  it('returns codex when both enabled and codex has higher success rate', () => {
    // codex 80%, claude 50%
    const { agent } = selectOptimizeAgent(makeConfig(true, true), makeReport(10, 5, 10, 8))
    expect(agent).toBe('codex')
  })

  it('returns claude when both enabled and claude has higher success rate', () => {
    // claude 90%, codex 60%
    const { agent } = selectOptimizeAgent(makeConfig(true, true), makeReport(10, 9, 10, 6))
    expect(agent).toBe('claude')
  })

  it('returns claude (default) when both enabled and rates are equal', () => {
    // both 70%
    const { agent } = selectOptimizeAgent(makeConfig(true, true), makeReport(10, 7, 10, 7))
    expect(agent).toBe('claude')
  })

  it('throws when no vendors are enabled', () => {
    expect(() => selectOptimizeAgent(makeConfig(false, false), makeReport())).toThrow(/No vendors enabled/)
  })

  it('reason string mentions source when only one vendor enabled', () => {
    const { reason } = selectOptimizeAgent(makeConfig(true, false), makeReport())
    expect(reason).toMatch(/only enabled vendor/)
  })

  it('reason string includes success rates when chosen by data', () => {
    const { reason } = selectOptimizeAgent(makeConfig(true, true), makeReport(10, 5, 10, 8))
    expect(reason).toMatch(/80%/)
    expect(reason).toMatch(/50%/)
  })
})
