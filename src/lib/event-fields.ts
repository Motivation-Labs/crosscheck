// Additive fields PR-A introduces on review_complete, fix_complete,
// and conflict_resolve_complete log events. Extracted so the field
// semantics can be tested without exercising the full workflow runner.
//
// Background: today `review_complete` is emitted for both review and
// recheck steps and the two are indistinguishable from the log alone,
// which blocks `diagnose --resolution` and the telemetry aggregators in
// PR #150 / PR #151. The step_type field closes that gap.

export interface StepIdentityFields {
  step_type: 'review' | 'recheck'
  step_name: string
}

// `effectiveType` comes from runner.ts's getEffectiveStepType — it is
// the coerced type used to decide step behavior. A workflow step typed
// `review` is coerced to `recheck` on rechecks runs (ctx.isRecheckRun).
// The log field must reflect what actually ran, not the workflow step's
// declared type, otherwise the review-vs-recheck split is lossy.
export function buildStepIdentityFields(
  effectiveType: string,
  stepName: string,
): StepIdentityFields {
  return {
    step_type: effectiveType === 'recheck' ? 'recheck' : 'review',
    step_name: stepName,
  }
}
