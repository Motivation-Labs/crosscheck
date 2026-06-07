import { describe, it, expect } from 'vitest'
import { hasBlockingFindings, applySeverityGate } from '../lib/verdict.js'

describe('hasBlockingFindings', () => {
  it('returns true for [P0]', () => {
    expect(hasBlockingFindings('- [P0] Data loss bug')).toBe(true)
  })

  it('returns true for [P1]', () => {
    expect(hasBlockingFindings('- [P1] Broken auth')).toBe(true)
  })

  it('returns true for [P2] — correctness bugs block merge', () => {
    expect(hasBlockingFindings('- [P2] Wrong locked-refund accounting')).toBe(true)
  })

  it('returns true for [P2] even when [P3] also present', () => {
    expect(hasBlockingFindings('- [P2] Logic bug\n- [P3] Rename variable')).toBe(true)
  })

  it('returns false for [P3] only — nits are non-blocking', () => {
    expect(hasBlockingFindings('- [P3] Rename variable for clarity')).toBe(false)
  })

  it('returns false when no priority markers present', () => {
    expect(hasBlockingFindings('The changes look correct and complete.')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(hasBlockingFindings('[p2] issue')).toBe(true)
    expect(hasBlockingFindings('[p3] nit')).toBe(false)
  })
})

describe('applySeverityGate', () => {
  it('keeps NEEDS WORK when review has [P2] findings', () => {
    const text = '- [P2] Missing org filter on document checks\n- Affects correctness of validation'
    const result = applySeverityGate('NEEDS WORK', text)
    expect(result.verdict).toBe('NEEDS WORK')
    expect(result.downgraded).toBe(false)
  })

  it('keeps NEEDS WORK when review has [P1] findings', () => {
    const text = '- [P1] Security issue in auth path'
    const result = applySeverityGate('NEEDS WORK', text)
    expect(result.verdict).toBe('NEEDS WORK')
    expect(result.downgraded).toBe(false)
  })

  it('downgrades NEEDS WORK to APPROVE when only [P3] nits present', () => {
    const text = '- [P3] Rename variable for clarity'
    const result = applySeverityGate('NEEDS WORK', text)
    expect(result.verdict).toBe('APPROVE')
    expect(result.downgraded).toBe(true)
  })

  it('downgrades NEEDS WORK to APPROVE when no findings at all', () => {
    const text = 'The changes look correct and well-structured.'
    const result = applySeverityGate('NEEDS WORK', text)
    expect(result.verdict).toBe('APPROVE')
    expect(result.downgraded).toBe(true)
  })

  it('never alters a BLOCK verdict', () => {
    const text = '- [P3] Nit only'
    const result = applySeverityGate('BLOCK', text)
    expect(result.verdict).toBe('BLOCK')
    expect(result.downgraded).toBe(false)
  })

  it('never alters an APPROVE verdict', () => {
    const result = applySeverityGate('APPROVE', 'looks good')
    expect(result.verdict).toBe('APPROVE')
    expect(result.downgraded).toBe(false)
  })

  it('handles null verdict without crashing', () => {
    const result = applySeverityGate(null, '- [P3] Nit')
    expect(result.verdict).toBe(null)
    expect(result.downgraded).toBe(false)
  })

  // Regression: PR #307 had two [P2] correctness bugs that were incorrectly APPROVED
  it('keeps NEEDS WORK for PR #307 pattern — two P2 correctness bugs', () => {
    const text = [
      '- [P2] Handle locked-source refunds in projection checks — finance_mvp_validation_service.py:171-175',
      '  When an org has a refund with metadata.source == "locked", the billing service moves that amount',
      '  from locked back to available and does not increment balance_refunded_usd.',
      '',
      '- [P2] Filter document checks to the requested org — finance_mvp_validation_repository.py:75-80',
      '  This query returns documents from other orgs because it only filters by document_type.',
    ].join('\n')
    const result = applySeverityGate('NEEDS WORK', text)
    expect(result.verdict).toBe('NEEDS WORK')
    expect(result.downgraded).toBe(false)
  })
})
