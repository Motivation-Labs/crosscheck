import { describe, it, expect } from 'vitest'
import {
  buildAnnotation,
  buildCommitTrailers,
  parseAnnotation,
  parseAnnotationFieldsFenced,
  type CrosscheckStepType,
} from '../lib/annotation.js'

describe('crosscheck annotation contract', () => {
  const stepTypes: CrosscheckStepType[] = ['review', 'recheck', 'fix', 'conflict-resolve']

  for (const type of stepTypes) {
    it(`round-trips ${type} annotations`, () => {
      const annotation = {
        origin: 'claude',
        reviewer: 'codex',
        model: 'gpt-5',
        type,
        round: 2,
        verdict: 'NEEDS_WORK',
        service: 'crosscheck',
      } as const

      expect(parseAnnotation(buildAnnotation(annotation))).toEqual(annotation)
    })
  }

  it('pins the emitted field order per type for snapshot stability', () => {
    const snapshots = stepTypes.map(type => buildAnnotation({
      origin: 'claude',
      reviewer: 'codex',
      model: 'gpt-5',
      type,
      round: 3,
      verdict: 'BLOCK',
      service: 'crosscheck',
    }))

    expect(snapshots).toEqual([
      '<!-- crosscheck: origin=claude reviewer=codex model=gpt-5 type=review round=3 verdict=BLOCK service=crosscheck -->',
      '<!-- crosscheck: origin=claude reviewer=codex model=gpt-5 type=recheck round=3 verdict=BLOCK service=crosscheck -->',
      '<!-- crosscheck: origin=claude reviewer=codex model=gpt-5 type=fix round=3 verdict=BLOCK service=crosscheck -->',
      '<!-- crosscheck: origin=claude reviewer=codex model=gpt-5 type=conflict-resolve round=3 verdict=BLOCK service=crosscheck -->',
    ])
  })

  it('appends optional head sha after stable v2 fields', () => {
    const annotation = buildAnnotation({
      origin: 'claude',
      reviewer: 'codex',
      model: 'gpt-5',
      type: 'review',
      round: 3,
      verdict: 'BLOCK',
      service: 'crosscheck',
      sha: 'abc1234',
    })

    expect(annotation).toBe(
      '<!-- crosscheck: origin=claude reviewer=codex model=gpt-5 type=review round=3 verdict=BLOCK service=crosscheck sha=abc1234 -->',
    )
    expect(parseAnnotation(annotation)).toEqual({
      origin: 'claude',
      reviewer: 'codex',
      model: 'gpt-5',
      type: 'review',
      round: 3,
      verdict: 'BLOCK',
      service: 'crosscheck',
      sha: 'abc1234',
    })
  })

  it('preserves bare marker handling when sha-like fields are absent', () => {
    expect(parseAnnotation('<!-- crosscheck: fix_applied -->')).toBeNull()
  })

  it('parses legacy annotations with documented defaults', () => {
    expect(parseAnnotation(
      '<!-- crosscheck: origin=claude reviewer=codex verdict=APPROVE type=review -->',
    )).toEqual({
      origin: 'claude',
      reviewer: 'codex',
      model: 'default',
      type: 'review',
      round: 1,
      verdict: 'APPROVE',
      service: 'crosscheck',
    })
  })

  it('keeps verdict-less review annotations parseable for freshness detection', () => {
    expect(parseAnnotation(
      '<!-- crosscheck: origin=claude reviewer=codex type=review -->',
    )).toEqual({
      origin: 'claude',
      reviewer: 'codex',
      model: 'default',
      type: 'review',
      round: 1,
      verdict: 'UNKNOWN',
      service: 'crosscheck',
    })
  })

  it('parses fields order-independently and ignores unknown fields', () => {
    expect(parseAnnotation(
      '<!-- crosscheck: service=custom verdict=BLOCK extra=yes round=4 type=recheck model=claude-opus reviewer=claude origin=codex -->',
    )).toEqual({
      origin: 'codex',
      reviewer: 'claude',
      model: 'claude-opus',
      type: 'recheck',
      round: 4,
      verdict: 'BLOCK',
      service: 'custom',
    })
  })

  it('uses the footer annotation when the body quotes older markers', () => {
    const body = 'Quoted marker `<!-- crosscheck: origin=claude reviewer=codex verdict=BLOCK type=review -->`\n\n'
      + '<!-- crosscheck: origin=claude reviewer=codex model=gpt-5 type=recheck round=2 verdict=APPROVE service=crosscheck -->'

    expect(parseAnnotation(body)?.type).toBe('recheck')
  })

  it('returns null for bare summary markers', () => {
    expect(parseAnnotation('<!-- crosscheck: fix_applied -->')).toBeNull()
  })

  it('skips fenced annotations and parses the footer annotation', () => {
    const body = [
      'Example:',
      '```',
      '<!-- crosscheck: origin=claude reviewer=codex type=review verdict=BLOCK -->',
      '```',
      '<!-- crosscheck: origin=codex reviewer=claude type=recheck verdict=APPROVE -->',
    ].join('\n')

    expect(parseAnnotation(body)?.type).toBe('recheck')
    expect(parseAnnotation(body)?.verdict).toBe('APPROVE')
  })

  it('exposes bare summary markers through the fenced field parser', () => {
    const fields = parseAnnotationFieldsFenced('<!-- crosscheck: fix_applied -->')

    expect(fields?.get('__marker__')).toBe('fix_applied')
  })
})

describe('crosscheck commit trailers', () => {
  it('emits reviewer, model, step, and service trailers', () => {
    expect(buildCommitTrailers({
      reviewer: 'claude',
      model: 'default',
      step: 'fix',
      service: 'crosscheck',
    })).toBe([
      'Crosscheck-Reviewer: claude',
      'Crosscheck-Model: default',
      'Crosscheck-Step: fix',
      'Crosscheck-Service: crosscheck',
    ].join('\n'))
  })
})
