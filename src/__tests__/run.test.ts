import { describe, expect, it } from 'vitest'
import { buildFixRecheckSteps, resolveWorkflowSteps } from '../commands/run.js'
import type { WorkflowStep } from '../lib/workflow.js'

const reviewStep: WorkflowStep = {
  name: 'review',
  type: 'review',
  reviewer: 'auto',
  max_rounds: 1,
  instructions: 'review instructions',
}

const fixStep: WorkflowStep = {
  name: 'fix',
  type: 'fix',
  reviewer: 'origin',
  max_rounds: 1,
  instructions: 'fix instructions',
}

const recheckStep: WorkflowStep = {
  name: 'recheck',
  type: 'recheck',
  reviewer: 'auto',
  max_rounds: 1,
  instructions: 'custom recheck',
}

describe('resolveWorkflowSteps', () => {
  it('synthesizes recheck when --steps asks for it but the workflow has only review+fix', () => {
    const steps = resolveWorkflowSteps([reviewStep, fixStep], ['fix', 'recheck'], 'codex')

    expect(steps.map(step => step.type)).toEqual(['fix', 'recheck'])
    expect(steps[1]).toMatchObject({
      name: 'recheck',
      type: 'recheck',
      reviewer: 'codex',
    })
  })

  it('preserves explicit recheck steps', () => {
    const steps = resolveWorkflowSteps([reviewStep, fixStep, recheckStep], ['fix', 'recheck'], 'claude')

    expect(steps.map(step => step.name)).toEqual(['fix', 'recheck'])
    expect(steps[1]).toMatchObject({
      instructions: 'custom recheck',
      reviewer: 'claude',
    })
  })
})

describe('buildFixRecheckSteps', () => {
  it('uses the full workflow for round-mode followups after an initial review-only run', () => {
    const steps = buildFixRecheckSteps([reviewStep], [reviewStep, fixStep], 'codex')

    expect(steps.map(step => step.type)).toEqual(['fix', 'recheck'])
    expect(steps[1]).toMatchObject({
      name: 'recheck',
      type: 'recheck',
      reviewer: 'codex',
    })
  })

  it('prepends fix for round-mode followups after an initial recheck-only run', () => {
    const steps = buildFixRecheckSteps([recheckStep], [reviewStep, fixStep, recheckStep], 'claude')

    expect(steps.map(step => step.type)).toEqual(['fix', 'recheck'])
    expect(steps[1]).toMatchObject({
      name: 'recheck',
      instructions: 'custom recheck',
      reviewer: 'auto',
    })
  })
})
