import { parseAnnotation, parseAnnotationFields } from './annotation.js'
import { evaluateWhen, type WorkflowStep } from './workflow.js'
import type { StepResult } from './workflow.js'
import { parseVerdict } from './verdict.js'

export type StepRecordType = 'review' | 'recheck' | 'fix' | 'conflict-resolve'

export interface StepRecord {
  type: StepRecordType
  /** APPROVE | NEEDS_WORK | BLOCK — from annotation or parsed from body */
  verdict?: string
  /** PR head SHA when this step ran (review/recheck only; absent on older comments) */
  sha?: string
  round: number
  commentId: number
  commentBody: string
  /** ISO 8601 timestamp from GitHub */
  createdAt: string
  reviewer?: string
  model?: string
  /** Pre-computed next workflow step from the annotation (review/recheck only) */
  next_step?: string
}

export interface NextStepResult {
  /** Next workflow step to execute, or null when the workflow is complete. */
  step: WorkflowStep | null
  /** For fix/recheck steps: the review comment to use as working context. */
  reviewComment?: { id: number; body: string }
  /** True when at least one review or recheck comment exists on the PR. */
  hasExistingReview: boolean
  /** Round number the next step should run as. */
  round: number
  /** Full parsed history in chronological order. */
  history: StepRecord[]
}

const VALID_STEP_TYPES = new Set<StepRecordType>(['review', 'recheck', 'fix', 'conflict-resolve'])

function commentToRecord(comment: { id: number; body: string; created_at: string }): StepRecord | null {
  const fields = parseAnnotationFields(comment.body)

  if (!fields) {
    // No annotation at all — detect legacy review comments by header pattern
    if (comment.body.includes('### Code Review by') && !comment.body.startsWith('> Recheck of')) {
      const { verdict } = parseVerdict(comment.body)
      return {
        type: 'review',
        ...(verdict !== null && { verdict }),
        round: 1,
        commentId: comment.id,
        commentBody: comment.body,
        createdAt: comment.created_at,
      }
    }
    return null
  }

  // Bareword markers: fix_applied and conflict_resolved have no origin/reviewer fields
  const marker = fields.get('__marker__')
  if (marker === 'fix_applied') {
    return { type: 'fix', round: 1, commentId: comment.id, commentBody: comment.body, createdAt: comment.created_at }
  }
  if (marker === 'conflict_resolved') {
    return { type: 'conflict-resolve', round: 1, commentId: comment.id, commentBody: comment.body, createdAt: comment.created_at }
  }

  // Full annotation (requires origin + reviewer)
  const parsed = parseAnnotation(comment.body)
  if (!parsed) return null

  const type = parsed.type as StepRecordType
  if (!VALID_STEP_TYPES.has(type)) return null

  const verdict = parsed.verdict && parsed.verdict !== 'UNKNOWN' ? parsed.verdict : undefined

  return {
    type,
    ...(verdict !== undefined && { verdict }),
    ...(parsed.sha !== undefined && { sha: parsed.sha }),
    round: parsed.round,
    commentId: comment.id,
    commentBody: comment.body,
    createdAt: comment.created_at,
    reviewer: parsed.reviewer,
    ...(parsed.model !== 'default' && { model: parsed.model }),
    ...(parsed.next_step !== undefined && { next_step: parsed.next_step }),
  }
}

type GHComment = { id: number; body: string; created_at: string }

function parseLastPage(linkHeader: string): number | null {
  const m = linkHeader.match(/page=(\d+)>;\s*rel="last"/)
  return m ? parseInt(m[1], 10) : null
}

/**
 * Fetch all crosscheck step records from a PR's comment thread in chronological order.
 *
 * Fast path (new annotations with next_step):
 *   1. Fetch the last page of comments to find the most recent review/recheck annotation.
 *   2. If it carries next_step, fetch only comments posted after it (via ?since=) to
 *      check for trailing fix markers — skipping the entire earlier thread.
 *
 * Full scan fallback (legacy annotations without next_step):
 *   Read all pages from page 1. Used only when the last review predates the next_step field.
 */
export async function fetchStepHistory(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<StepRecord[]> {
  const base = `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }

  // Fetch the first page to discover total pagination
  const firstRes = await fetch(`${base}?per_page=100`, { headers })
  if (!firstRes.ok) return []
  const firstPage = await firstRes.json() as GHComment[]
  if (firstPage.length === 0) return []

  const lastPage = parseLastPage(firstRes.headers.get('link') ?? '')

  // ── Fast path ──────────────────────────────────────────────────────────────
  // When the thread spans multiple pages, jump to the last page and look for
  // the most recent review/recheck annotation with a next_step hint.
  if (lastPage !== null && lastPage > 1) {
    const tailRes = await fetch(`${base}?per_page=100&page=${lastPage}`, { headers })
    if (tailRes.ok) {
      const tailPage = await tailRes.json() as GHComment[]
      // Walk tail page in reverse to find the freshest review/recheck annotation
      const anchor = [...tailPage].reverse().find(c => {
        const r = commentToRecord(c)
        return r !== null && (r.type === 'review' || r.type === 'recheck') && r.next_step !== undefined
      })
      if (anchor) {
        const anchorRecord = commentToRecord(anchor)!
        // Fetch only comments posted after the anchor (the few trailing ones)
        const sinceRes = await fetch(`${base}?per_page=100&since=${anchor.created_at}`, { headers })
        const sinceComments: GHComment[] = sinceRes.ok ? await sinceRes.json() as GHComment[] : []
        // sinceComments includes the anchor itself (GitHub's ?since= is inclusive-by-second),
        // so deduplicate by ID.
        const seen = new Set<number>([anchorRecord.commentId])
        const trailing: StepRecord[] = []
        for (const c of sinceComments) {
          if (seen.has(c.id)) continue
          seen.add(c.id)
          const r = commentToRecord(c)
          if (r) trailing.push(r)
        }
        return [anchorRecord, ...trailing]
      }
    }
  }

  // ── Full scan fallback ─────────────────────────────────────────────────────
  const records: StepRecord[] = []
  const allPages: GHComment[][] = [firstPage]
  let page = 2
  while (true) {
    const res = await fetch(`${base}?per_page=100&page=${page}`, { headers })
    if (!res.ok) break
    const data = await res.json() as GHComment[]
    if (data.length === 0) break
    allPages.push(data)
    if (data.length < 100) break
    page++
  }
  for (const batch of allPages) {
    for (const comment of batch) {
      const record = commentToRecord(comment)
      if (record) records.push(record)
    }
  }
  return records
}

/**
 * Given the PR's step history and the current HEAD SHA, determine which workflow
 * step should run next.
 *
 * The algorithm replays the history from the end:
 *  1. No review/recheck on record → start from the review step.
 *  2. Current SHA not reviewed yet:
 *     - A fix was applied since the last review → recheck is next.
 *     - No fix → human pushed a new commit; fresh review is next.
 *  3. Current SHA already reviewed → walk the workflow steps that follow
 *     and return the first whose `when` condition evaluates to true and
 *     that hasn't already been completed in history.
 */
export function identifyNextWorkflowStep(
  history: StepRecord[],
  steps: WorkflowStep[],
  currentSha: string,
): NextStepResult {
  const reviewHistory = history.filter(r => r.type === 'review' || r.type === 'recheck')
  const hasExistingReview = reviewHistory.length > 0

  if (!hasExistingReview) {
    const firstStep = steps.find(s => s.type === 'review') ?? steps[0] ?? null
    return { step: firstStep, hasExistingReview: false, round: 1, history }
  }

  const lastReview = reviewHistory[reviewHistory.length - 1]
  const lastReviewIdx = history.lastIndexOf(lastReview)
  const historyAfterReview = history.slice(lastReviewIdx + 1)
  const fixAfterReview = historyAfterReview.some(r => r.type === 'fix' || r.type === 'conflict-resolve')

  // Build synthetic results so evaluateWhen works correctly for downstream steps.
  // Always populate under the literal key 'review' so conditions like
  // "review.verdict != 'APPROVE'" work regardless of the step's name in the workflow.
  const syntheticResults: Record<string, StepResult> = {
    review: { verdict: lastReview.verdict },
  }
  const reviewStepDef = steps.find(s => s.type === 'review' || s.type === 'recheck')
  if (reviewStepDef && reviewStepDef.name !== 'review') {
    syntheticResults[reviewStepDef.name] = { verdict: lastReview.verdict }
  }
  if (fixAfterReview) {
    syntheticResults['fix'] = { applied_count: 1 }
    const fixStepDef = steps.find(s => s.type === 'fix')
    if (fixStepDef && fixStepDef.name !== 'fix') syntheticResults[fixStepDef.name] = { applied_count: 1 }
  }

  // Legacy comments have no sha field — treat as not reviewed so new commits
  // always get a fresh review rather than inheriting an old approval.
  const reviewedCurrentSha = lastReview.sha !== undefined && lastReview.sha === currentSha

  if (!reviewedCurrentSha) {
    // Human pushed a new commit, or fix_applied has no SHA to verify against —
    // in either case we can't confirm currentSha is the fix commit, so require a fresh review.
    const reviewStep = steps.find(s => s.type === 'review') ?? steps[0] ?? null
    return { step: reviewStep, hasExistingReview: true, round: lastReview.round + 1, history }
  }

  // Current SHA has been reviewed — find the first incomplete step that follows
  let passedReview = false
  for (const step of steps) {
    if (step.type === 'review' || step.type === 'recheck') {
      passedReview = true
      continue // done for this sha
    }
    if (!passedReview) continue
    if (step.when && !evaluateWhen(step.when, syntheticResults)) continue

    if (step.type === 'fix') {
      if (fixAfterReview) {
        syntheticResults[step.name] = { applied_count: 1 }
        syntheticResults['fix'] = { applied_count: 1 }
        continue // already ran
      }
      return {
        step,
        reviewComment: { id: lastReview.commentId, body: lastReview.commentBody },
        hasExistingReview: true,
        round: lastReview.round,
        history,
      }
    }

    if (step.type === 'conflict-resolve') {
      const conflictDone = historyAfterReview.some(r => r.type === 'conflict-resolve')
      if (conflictDone) continue
      return { step, hasExistingReview: true, round: lastReview.round, history }
    }
  }

  return { step: null, hasExistingReview: true, round: lastReview.round, history }
}
