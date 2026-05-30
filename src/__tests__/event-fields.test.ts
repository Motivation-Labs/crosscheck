import { describe, it, expect } from 'vitest'
import { buildStepIdentityFields } from '../lib/event-fields.js'

describe('buildStepIdentityFields', () => {
  // Effective type 'review' means this call is actually a fresh review,
  // regardless of what the workflow step is named. The default workflow
  // calls the initial step "review" but a user could rename it.
  it('returns step_type=review when effectiveType is review', () => {
    expect(buildStepIdentityFields('review', 'review')).toEqual({
      step_type: 'review',
      step_name: 'review',
    })
  })

  it('preserves a custom step_name unchanged', () => {
    expect(buildStepIdentityFields('review', 'initial-codex-pass')).toEqual({
      step_type: 'review',
      step_name: 'initial-codex-pass',
    })
  })

  // Effective type 'recheck' is the case the field exists to disambiguate:
  // today this is logged identically to a fresh review.
  it('returns step_type=recheck when effectiveType is recheck', () => {
    expect(buildStepIdentityFields('recheck', 'recheck')).toEqual({
      step_type: 'recheck',
      step_name: 'recheck',
    })
  })

  // Coerced rechecks: runner.ts's getEffectiveStepType maps the workflow
  // step typed 'review' to effectiveType 'recheck' when ctx.isRecheckRun.
  // The step_name still reflects what's in workflow.yml (so analytics can
  // group by workflow step), but step_type reflects what actually ran.
  it('returns step_type=recheck even when the underlying workflow step is named "review"', () => {
    expect(buildStepIdentityFields('recheck', 'review')).toEqual({
      step_type: 'recheck',
      step_name: 'review',
    })
  })

  // Defensive: any other effectiveType value (shouldn't happen for the
  // review_complete emit site, but the helper must not produce undefined).
  it('falls back to step_type=review for any non-recheck effectiveType', () => {
    expect(buildStepIdentityFields('fix', 'whatever')).toEqual({
      step_type: 'review',
      step_name: 'whatever',
    })
    expect(buildStepIdentityFields('', 'whatever')).toEqual({
      step_type: 'review',
      step_name: 'whatever',
    })
  })
})
