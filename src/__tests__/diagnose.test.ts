import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { classifyError, buildDiagnoseReport } from '../commands/diagnose.js'

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

  it('detects auth_failure on 401', () => {
    const r = classifyError('Response 401: bad credentials')
    expect(r.pattern).toBe('auth_failure')
  })

  it('detects auth_failure on unauthorized', () => {
    const r = classifyError('Error: Unauthorized — check your token')
    expect(r.pattern).toBe('auth_failure')
  })

  it('falls back to other for unrecognised message', () => {
    const r = classifyError('some completely unknown error')
    expect(r.pattern).toBe('other')
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
})
