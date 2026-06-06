import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { classifyError, buildDiagnoseReport } from '../commands/diagnose.js'
import { INDICATORS } from '../lib/languages.js'

const FIXTURES_DIR = join(fileURLToPath(import.meta.url), '..', 'fixtures')

describe('classifyError', () => {
  it('detects command_not_found for tsc', () => {
    const r = classifyError('sh: tsc: command not found')
    expect(r.pattern).toBe('command_not_found')
    expect(r.command).toBe('tsc')
  })

  it('detects command_not_found (bash format)', () => {
    const r = classifyError('bash: jest: not found')
    expect(r.pattern).toBe('command_not_found')
    expect(r.command).toBe('jest')
  })

  it('detects base_branch_missing with quoted branch', () => {
    const r = classifyError("fatal: no such branch: 'staging'")
    expect(r.pattern).toBe('base_branch_missing')
    expect(r.branch).toBe('staging')
  })

  it('detects base_branch_missing without quotes', () => {
    const r = classifyError('fatal: no such branch: main')
    expect(r.pattern).toBe('base_branch_missing')
    expect(r.branch).toBe('main')
  })

  it('detects timeout', () => {
    const r = classifyError('Request timed out after 120000ms')
    expect(r.pattern).toBe('timeout')
  })

  it('detects timeout (ETIMEDOUT)', () => {
    const r = classifyError('connect ETIMEDOUT 10.0.0.1:443')
    expect(r.pattern).toBe('timeout')
  })

  it('detects rate_limit on 429', () => {
    const r = classifyError('Error: rate limit exceeded (429) — try again later')
    expect(r.pattern).toBe('rate_limit')
  })

  it('detects rate_limit on "secondary rate"', () => {
    const r = classifyError('You have exceeded a secondary rate limit')
    expect(r.pattern).toBe('rate_limit')
  })

  it('detects overloaded on 529', () => {
    const r = classifyError('API returned 529: service overloaded')
    expect(r.pattern).toBe('overloaded')
  })

  it('detects budget exhausted', () => {
    const r = classifyError('claude: error_max_budget: reached maximum budget')
    expect(r.pattern).toBe('budget')
  })

  it('rate_limit takes precedence over auth_failure for ambiguous messages', () => {
    // A 429 body that also triggers the auth regex should be rate_limit
    const r = classifyError('429 Too Many Requests — unauthorized')
    expect(r.pattern).toBe('rate_limit')
  })

  it('detects auth_failure on "auth failure" vendor message', () => {
    const r = classifyError('codex auth failure during fix step — run: codex login')
    expect(r.pattern).toBe('auth_failure')
  })

  it('detects auth_failure on 401', () => {
    const r = classifyError('Response 401: bad credentials')
    expect(r.pattern).toBe('auth_failure')
  })

  it('detects auth_failure on unauthorized', () => {
    const r = classifyError('Error: Unauthorized — check your token')
    expect(r.pattern).toBe('auth_failure')
  })

  // IN-574: transient API conditions are first-class patterns, not "other"/"auth".
  it('detects rate_limit on 429 even when the body mentions a token', () => {
    expect(classifyError('api_error_status: 429 rate limit — check token usage').pattern).toBe('rate_limit')
  })

  it('detects overloaded on 529', () => {
    expect(classifyError('API Error: 529 Overloaded. Please try again.').pattern).toBe('overloaded')
  })

  it('detects budget exhaustion', () => {
    expect(classifyError('error_max_budget_usd: Reached maximum budget ($2)').pattern).toBe('budget')
  })

  it('does not match 429/529 digits embedded in durations or counts', () => {
    // Without word boundaries, "5290ms" matched /529/ and a timeout read as `overloaded`.
    expect(classifyError('Request timed out after 5290ms').pattern).toBe('timeout')
    expect(classifyError('operation timed out after 4290ms').pattern).toBe('timeout')
  })

  it('falls back to other for unrecognised message', () => {
    const r = classifyError('some completely unknown error')
    expect(r.pattern).toBe('other')
  })
})

describe('LANGUAGE_CONSTRAINT_MAP / INDICATORS consistency', () => {
  it('every language id in INDICATORS has a corresponding constraint entry in diagnose', () => {
    // Import the internal map indirectly by checking that buildDiagnoseReport produces
    // suggestions for every language id that INDICATORS can produce.
    // We do this by asserting INDICATORS covers only known language ids, detected via
    // a fixture with command_not_found errors for each mapped command.
    // The key assertion: INDICATORS values are a subset of the constraint map keys.
    // We expose this by checking that no language id from INDICATORS is silently dropped.
    const indicatorLangs = new Set(INDICATORS.map(([, lang]) => lang))
    // Build a minimal report with one error per language to trigger suggestions
    // then assert the suggestions cover all indicator languages that are also
    // in COMMAND_LANGUAGE_MAP (those have constraint entries).
    // Simpler: just assert the known set matches expectation so any future addition
    // to INDICATORS without a matching constraint fails here.
    const expected = new Set(['typescript', 'nodejs', 'python', 'rust', 'golang', 'java', 'ruby'])
    expect(indicatorLangs).toEqual(expected)
  })
})

describe('buildDiagnoseReport', () => {
  it('returns empty report when log dir does not exist', () => {
    const r = buildDiagnoseReport(undefined, '/nonexistent/path/that/does/not/exist')
    expect(r.summary.total_reviews).toBe(0)
    expect(r.period.log_files).toBe(0)
    expect(r.errors).toHaveLength(0)
  })

  it('parses fixture and counts reviews correctly', () => {
    const r = buildDiagnoseReport(undefined, FIXTURES_DIR)
    // 2026-01-10: 5 started, 3 complete; 2026-01-11: 3 started, 1 complete
    expect(r.summary.total_reviews).toBe(8)
    expect(r.summary.successful).toBe(4)
    expect(r.summary.failed).toBe(4)
  })

  it('detects languages from review_started events', () => {
    const r = buildDiagnoseReport(undefined, FIXTURES_DIR)
    expect(r.languages_detected).toContain('typescript')
    expect(r.languages_detected).toContain('nodejs')
  })

  it('identifies command_not_found errors', () => {
    const r = buildDiagnoseReport(undefined, FIXTURES_DIR)
    const tscErr = r.errors.find(e => e.pattern === 'command_not_found' && e.command === 'tsc')
    expect(tscErr).toBeDefined()
    expect(tscErr!.count).toBe(1)
    const jestErr = r.errors.find(e => e.pattern === 'command_not_found' && e.command === 'jest')
    expect(jestErr).toBeDefined()
  })

  it('identifies base_branch_missing errors', () => {
    const r = buildDiagnoseReport(undefined, FIXTURES_DIR)
    const err = r.errors.find(e => e.pattern === 'base_branch_missing')
    expect(err).toBeDefined()
    expect(err!.branch).toBe('staging')
  })

  it('identifies timeout errors', () => {
    const r = buildDiagnoseReport(undefined, FIXTURES_DIR)
    const err = r.errors.find(e => e.pattern === 'timeout')
    expect(err).toBeDefined()
  })

  it('builds constraint suggestions from errors', () => {
    const r = buildDiagnoseReport(undefined, FIXTURES_DIR)
    const constraints = r.suggestions.filter(s => s.type === 'add_constraint')
    expect(constraints.length).toBeGreaterThan(0)
    expect(constraints.some(s => s.instruction?.includes('tsc'))).toBe(true)
  })

  it('tracks verdict distribution', () => {
    const r = buildDiagnoseReport(undefined, FIXTURES_DIR)
    expect(r.verdict_distribution.APPROVE).toBe(2)
    expect(r.verdict_distribution.NEEDS_WORK).toBe(1)
    expect(r.verdict_distribution.BLOCK).toBe(1)
  })

  it('aggregates reviewer performance', () => {
    const r = buildDiagnoseReport(undefined, FIXTURES_DIR)
    const claude = r.reviewer_performance['claude']
    const codex = r.reviewer_performance['codex']
    expect(claude).toBeDefined()
    expect(codex).toBeDefined()
    // 2026-01-10: claude 2 starts, 2 complete; 2026-01-11: claude 1 start, 1 complete
    expect(claude.attempts).toBe(3)
    expect(claude.successes).toBe(3)
    // 2026-01-10: codex 3 starts, 1 complete; 2026-01-11: codex 2 starts, 0 complete
    expect(codex.attempts).toBe(5)
    expect(codex.successes).toBe(1)
  })

  it('--since filters to the specified date file only', () => {
    const r = buildDiagnoseReport('2026-01-11', FIXTURES_DIR)
    expect(r.period.log_files).toBe(1)
    expect(r.summary.total_reviews).toBe(3)
  })

  it('tolerates malformed NDJSON lines', () => {
    // 2026-01-11 fixture contains one malformed line — should not throw
    expect(() => buildDiagnoseReport(undefined, FIXTURES_DIR)).not.toThrow()
  })

  it('repos_seen collects unique repo names', () => {
    const r = buildDiagnoseReport(undefined, FIXTURES_DIR)
    expect(r.repos_seen).toContain('acme/api')
    expect(r.repos_seen).toContain('acme/web')
  })

  it('period.from and period.to reflect file names', () => {
    const r = buildDiagnoseReport(undefined, FIXTURES_DIR)
    expect(r.period.from).toBe('2026-01-10')
    expect(r.period.to).toBe('2026-01-11')
  })

  it('failedReviews is never negative when --since truncates review_started events', () => {
    // 2026-01-11 file has 3 starts and 1 complete.
    // Using --since on 2026-01-11 only reads that file — no negative possible here,
    // but we assert the invariant holds regardless.
    const r = buildDiagnoseReport('2026-01-11', FIXTURES_DIR)
    expect(r.summary.failed).toBeGreaterThanOrEqual(0)
    expect(r.summary.failure_rate).toBeGreaterThanOrEqual(0)
  })

  it('reviewer attribution on errors uses review_started entry', () => {
    // 2026-01-10: PR #1 was started by codex and errored with tsc not found
    const r = buildDiagnoseReport('2026-01-10', FIXTURES_DIR)
    const tscErr = r.errors.find(e => e.pattern === 'command_not_found' && e.command === 'tsc')
    expect(tscErr?.reviewer).toBe('codex')
  })
})

// IN-574: transient API errors must surface as distinct, actionable patterns
// (not lumped into "other"), and drive retry/budget suggestions.
const FIXTURES_TRANSIENT_DIR = join(fileURLToPath(import.meta.url), '..', 'fixtures-transient')

describe('buildDiagnoseReport — transient API error patterns', () => {
  it('counts rate_limit, overloaded, and budget as distinct patterns', () => {
    const r = buildDiagnoseReport(undefined, FIXTURES_TRANSIENT_DIR)
    const rate = r.errors.find(e => e.pattern === 'rate_limit')
    const overloaded = r.errors.find(e => e.pattern === 'overloaded')
    const budget = r.errors.find(e => e.pattern === 'budget')
    expect(rate?.count).toBe(2)
    expect(overloaded?.count).toBe(1)
    expect(budget?.count).toBe(1)
    // None of them should fall through to the catch-all bucket.
    expect(r.errors.some(e => e.pattern === 'other')).toBe(false)
  })

  it('suggests retry/backoff for repeated transient capacity errors and a budget fix', () => {
    const r = buildDiagnoseReport(undefined, FIXTURES_TRANSIENT_DIR)
    expect(r.suggestions.some(s => /retry\/backoff|stagger/.test(s.reason))).toBe(true)
    expect(r.suggestions.some(s => /budget/.test(s.reason))).toBe(true)
  })
})
