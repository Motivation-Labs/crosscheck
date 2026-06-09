import { describe, it, expect } from 'vitest'
import { applySeverityGate, hasBlockingFindings, parseVerdict } from '../lib/verdict.js'

// Reproduces the IN-628 non-convergence pattern: the IN-625 PR #28 review at 11:49
// had "Critical Issues: None" yet returned NEEDS WORK on three warnings, so the
// fix/recheck loop never terminated. The severity gate must downgrade that to APPROVE.
const WARNINGS_ONLY_REVIEW = [
  '## Summary',
  'Adds inspection commands. Looks solid overall.',
  '## Critical Issues',
  'None.',
  '## Warnings',
  '1. isValidRepoArg false negative on ../foo',
  '2. isUnsafeRunId("") returns false',
  '3. confirm() blocks on non-TTY stdin',
  '## Suggestions',
  '- Move the constant above its first use.',
  '',
  'VERDICT: NEEDS WORK',
].join('\n')

const REAL_CRITICAL_REVIEW = [
  '## Summary',
  'A correctness bug slipped in.',
  '## Critical Issues',
  '- src/auth.ts:12 — token comparison is non-constant-time, auth bypass.',
  '## Warnings',
  '- minor: rename a variable',
  '',
  'VERDICT: NEEDS WORK',
].join('\n')

describe('hasBlockingFindings', () => {
  it('is false when Critical Issues section is an explicit None', () => {
    expect(hasBlockingFindings(WARNINGS_ONLY_REVIEW)).toBe(false)
  })

  it('treats "- None", "N/A", "None found" as empty', () => {
    for (const none of ['- None', 'N/A', 'None found.', '_None identified_', 'no critical issues']) {
      const text = `## Critical Issues\n${none}\n## Warnings\n- something`
      expect(hasBlockingFindings(text)).toBe(false)
    }
  })

  it('is true when the Critical Issues section lists a real finding', () => {
    expect(hasBlockingFindings(REAL_CRITICAL_REVIEW)).toBe(true)
  })

  it('P0/P1/P2 markers block; P3-only does not', () => {
    expect(hasBlockingFindings('- [P0] data loss')).toBe(true)
    expect(hasBlockingFindings('- [P1] broken auth')).toBe(true)
    expect(hasBlockingFindings('- [P2] correctness bug')).toBe(true)
    expect(hasBlockingFindings('- [P2] medium\n- [P3] minor')).toBe(true)
    expect(hasBlockingFindings('- [P3] minor nit only')).toBe(false)
  })

  it('is false when there is no recognizable Critical section (NEEDS WORK is non-blocking by definition)', () => {
    expect(hasBlockingFindings('## Summary\nSome nits.\n## Suggestions\n- tidy up')).toBe(false)
  })
})

describe('applySeverityGate', () => {
  it('downgrades the IN-625 warnings-only NEEDS WORK to APPROVE', () => {
    const { verdict } = parseVerdict(WARNINGS_ONLY_REVIEW)
    expect(verdict).toBe('NEEDS WORK')
    const gated = applySeverityGate(verdict, WARNINGS_ONLY_REVIEW)
    expect(gated.verdict).toBe('APPROVE')
    expect(gated.downgraded).toBe(true)
  })

  it('keeps NEEDS WORK when a real Critical finding is present', () => {
    const gated = applySeverityGate('NEEDS WORK', REAL_CRITICAL_REVIEW)
    expect(gated.verdict).toBe('NEEDS WORK')
    expect(gated.downgraded).toBe(false)
  })

  it('never alters BLOCK', () => {
    const gated = applySeverityGate('BLOCK', WARNINGS_ONLY_REVIEW)
    expect(gated.verdict).toBe('BLOCK')
    expect(gated.downgraded).toBe(false)
  })

  it('never alters APPROVE', () => {
    const gated = applySeverityGate('APPROVE', WARNINGS_ONLY_REVIEW)
    expect(gated.verdict).toBe('APPROVE')
    expect(gated.downgraded).toBe(false)
  })

  it('leaves a null verdict untouched', () => {
    const gated = applySeverityGate(null, WARNINGS_ONLY_REVIEW)
    expect(gated.verdict).toBe(null)
    expect(gated.downgraded).toBe(false)
  })
})
