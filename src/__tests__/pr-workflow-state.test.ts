import { describe, expect, it } from 'vitest'
import { commitToRecord, identifyNextWorkflowStep, type StepRecord } from '../lib/pr-workflow-state.js'
import type { RawPRCommit } from '../github/client.js'
import type { WorkflowStep } from '../lib/workflow.js'

const conflictResolveStep: WorkflowStep = {
  name: 'conflict-resolve',
  type: 'conflict-resolve',
  reviewer: 'origin',
  max_rounds: 1,
  instructions: 'resolve conflicts',
}

const reviewStep: WorkflowStep = {
  name: 'review',
  type: 'review',
  reviewer: 'auto',
  max_rounds: 1,
  instructions: 'review',
}

const fixStep: WorkflowStep = {
  name: 'fix',
  type: 'fix',
  reviewer: 'origin',
  when: "review.verdict != 'APPROVE'",
  max_rounds: 1,
  instructions: 'fix',
}

const recheckStep: WorkflowStep = {
  name: 'recheck',
  type: 'recheck',
  reviewer: 'auto',
  max_rounds: 1,
  instructions: 'recheck',
}

const workflow = [conflictResolveStep, reviewStep, fixStep, recheckStep]

function record(overrides: Partial<StepRecord>): StepRecord {
  return {
    type: 'review',
    round: 1,
    commentId: 100,
    commentBody: 'review body',
    createdAt: '2026-06-02T00:00:00Z',
    ...overrides,
  }
}

describe('identifyNextWorkflowStep', () => {
  it('starts with conflict-resolve before the initial review', () => {
    const next = identifyNextWorkflowStep([], workflow, 'head-sha')

    expect(next.step?.type).toBe('conflict-resolve')
    expect(next.round).toBe(1)
  })

  it('runs the initial review after conflict-resolve completes', () => {
    const next = identifyNextWorkflowStep([
      record({ type: 'conflict-resolve', commentId: 99 }),
    ], workflow, 'head-sha')

    expect(next.step?.type).toBe('review')
    expect(next.round).toBe(1)
  })

  it('routes a non-APPROVE initial review to fix even when HEAD has moved', () => {
    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'BLOCK', sha: 'reviewed-sha' }),
    ], workflow, 'new-head-sha')

    expect(next.step?.type).toBe('fix')
    expect(next.reviewComment?.id).toBe(100)
    expect(next.round).toBe(1)
  })

  it('routes a non-APPROVE recheck to fix', () => {
    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'BLOCK', sha: 'first-sha' }),
      record({ type: 'fix', commentId: 101 }),
      record({ type: 'recheck', verdict: 'NEEDS_WORK', sha: 'fixed-sha', round: 1, commentId: 102 }),
    ], workflow, 'fixed-sha')

    expect(next.step?.type).toBe('fix')
    expect(next.reviewComment?.id).toBe(102)
    expect(next.round).toBe(1)
  })

  it('routes a current-head fix after review to recheck', () => {
    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'BLOCK', sha: 'reviewed-sha' }),
      record({ type: 'fix', commentId: 101, pushedSha: 'fix-sha' }),
    ], workflow, 'fix-sha')

    expect(next.step?.type).toBe('recheck')
    expect(next.reviewComment?.id).toBe(100)
    expect(next.round).toBe(1)
  })

  it('routes a stale fix followed by a new HEAD back to review', () => {
    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'BLOCK', sha: 'reviewed-sha' }),
      record({ type: 'fix', commentId: 101, pushedSha: 'fix-sha' }),
    ], workflow, 'new-head-sha')

    expect(next.step?.type).toBe('review')
    expect(next.round).toBe(2)
  })

  it('counts a commit-trailer fix as a completed fix step', () => {
    const fixRecord = commitToRecord({
      sha: '59abeb630af4efbc874650db88ecf3dcb02724fb',
      commit: {
        message: [
          '[crosscheck] fix: apply fixes from code review',
          '',
          'Crosscheck-Reviewer: claude',
          'Crosscheck-Model: claude-sonnet-4-6',
          'Crosscheck-Step: fix',
          'Crosscheck-Service: crosscheck',
        ].join('\n'),
        committer: { date: '2026-06-02T01:08:00Z' },
      },
    } satisfies RawPRCommit)

    expect(fixRecord).toMatchObject({
      type: 'fix',
      pushedSha: '59abeb630af4efbc874650db88ecf3dcb02724fb',
      reviewer: 'claude',
      model: 'claude-sonnet-4-6',
      source: 'commit',
    })

    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'BLOCK', sha: 'reviewed-sha' }),
      fixRecord!,
    ], workflow, '59abeb630af4efbc874650db88ecf3dcb02724fb')

    expect(next.step?.type).toBe('recheck')
    expect(next.reviewComment?.id).toBe(100)
  })

  it('routes a trailer fix followed by another HEAD back to review', () => {
    const fixRecord = commitToRecord({
      sha: '59abeb630af4efbc874650db88ecf3dcb02724fb',
      commit: {
        message: [
          '[crosscheck] fix: apply fixes from code review',
          '',
          'Crosscheck-Reviewer: claude',
          'Crosscheck-Model: claude-sonnet-4-6',
          'Crosscheck-Step: fix',
          'Crosscheck-Service: crosscheck',
        ].join('\n'),
        committer: { date: '2026-06-02T01:08:00Z' },
      },
    } satisfies RawPRCommit)

    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'BLOCK', sha: 'reviewed-sha' }),
      fixRecord!,
    ], workflow, 'later-human-sha')

    expect(next.step?.type).toBe('review')
    expect(next.round).toBe(2)
  })

  it('uses review rather than recheck when a new HEAD appears after APPROVE', () => {
    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'APPROVE', sha: 'approved-sha' }),
    ], workflow, 'new-head-sha')

    expect(next.step?.type).toBe('review')
    expect(next.round).toBe(2)
  })
})
