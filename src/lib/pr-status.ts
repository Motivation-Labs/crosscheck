import { parseAnnotationFieldsFenced } from './annotation.js'

export type PRReviewState = 'PR' | 'APPROVE' | 'NEEDS_WORK' | 'BLOCK' | 'FIX' | 'RECHECK'
export type PRNextAction = 'review' | 'fix' | 'recheck' | 'none'
export type PRVerdict = 'APPROVE' | 'NEEDS_WORK' | 'BLOCK'

export interface PRStatusCommit {
  sha: string
  committedAt?: string
}

export interface PRStatusCommitStatus {
  context: string
  state: string
  updatedAt?: string
}

export interface PRStatusPullRequest {
  owner: string
  repo: string
  number: number
  title: string
  author: string
  headSha: string
  headRef: string
  headRepo: string | null
  baseRef: string
  body: string | null
  createdAt: string
  updatedAt?: string
  commits?: PRStatusCommit[]
  commitStatuses?: PRStatusCommitStatus[]
}

export interface PRStatusComment {
  id: number
  body: string
  createdAt?: string
  updatedAt?: string
}

export interface PRStatusLogEvent {
  ts?: string
  level?: string
  event: string
  repo?: string
  pr?: number
  sha?: string
  headSha?: string
  head_sha?: string
  step_type?: string
  type?: string
  verdict?: string | null
  applied_count?: number
  tokens_used?: number
  [key: string]: unknown
}

export interface TokenBucket {
  review: number
  fix: number
  recheck: number
  total: number
}

export interface TokenTotals {
  byPR: Record<string, TokenBucket>
  byPRHeadSha: Record<string, TokenBucket>
}

export interface PRProgressStep {
  kind: 'cr' | 'fix' | 'recheck'
  at: Date
  verdict?: PRVerdict
  appliedCount?: number
  tokens?: number
}

export interface PRStatus {
  pr: PRStatusPullRequest
  state: PRReviewState
  nextAction: PRNextAction
  verdict: PRVerdict | null
  lastActive: Date
  tokenTotals: TokenBucket
  progress: PRProgressStep[]
  stale?: boolean
}

interface ParsedAnnotation {
  marker?: string
  type?: string
  reviewer?: string
  verdict?: PRVerdict
}

interface ReviewEvent {
  type: 'review' | 'recheck'
  verdict: PRVerdict
  at: Date
}

interface FixEvent {
  at: Date
  appliedCount?: number
  tokens?: number
  complete: boolean
}

const EMPTY_BUCKET: TokenBucket = { review: 0, fix: 0, recheck: 0, total: 0 }

function cloneBucket(bucket: TokenBucket = EMPTY_BUCKET): TokenBucket {
  return { review: bucket.review, fix: bucket.fix, recheck: bucket.recheck, total: bucket.total }
}

function addTokens(bucket: TokenBucket, kind: keyof Omit<TokenBucket, 'total'>, tokens: number): void {
  bucket[kind] += tokens
  bucket.total += tokens
}

function prKey(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${number}`
}

function logEventKey(event: PRStatusLogEvent): string | null {
  if (!event.repo || typeof event.pr !== 'number') return null
  return `${event.repo}#${event.pr}`
}

function logEventSha(event: PRStatusLogEvent): string | null {
  if (typeof event.sha === 'string' && event.sha.length > 0) return event.sha
  if (typeof event.headSha === 'string' && event.headSha.length > 0) return event.headSha
  if (typeof event.head_sha === 'string' && event.head_sha.length > 0) return event.head_sha
  return null
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function maxDate(current: Date | null, candidate: Date | null): Date | null {
  if (!candidate) return current
  if (!current || candidate.getTime() > current.getTime()) return candidate
  return current
}

function normalizeVerdict(value: string | undefined): PRVerdict | undefined {
  if (!value) return undefined
  const normalized = value.trim().toUpperCase().replace(/\s+/g, '_')
  if (normalized === 'APPROVE') return 'APPROVE'
  if (normalized === 'NEEDS_WORK' || normalized === 'NEEDSWORK') return 'NEEDS_WORK'
  if (normalized === 'BLOCK') return 'BLOCK'
  return undefined
}

// Delegates to the canonical fence-aware parser in annotation.ts so the logic
// lives in one place. Returns a simplified ParsedAnnotation for pr-status use.
function parseLatestCrosscheckAnnotation(body: string): ParsedAnnotation | null {
  const fields = parseAnnotationFieldsFenced(body)
  if (!fields) return null
  const attrs: ParsedAnnotation = {}
  for (const [key, value] of fields) {
    if (key === '__marker__') attrs.marker = value
    else if (key === 'type') attrs.type = value
    else if (key === 'reviewer') attrs.reviewer = value
    else if (key === 'verdict') attrs.verdict = normalizeVerdict(value)
  }
  return attrs
}

// Use createdAt for ordering review events — updatedAt would flip verdict
// ordering if an older comment is edited after a newer one is posted.
function commentCreatedAt(comment: PRStatusComment): Date | null {
  return parseDate(comment.createdAt)
}

// Use updatedAt for lastActive computation so edits and reactions are captured.
function commentDate(comment: PRStatusComment): Date | null {
  return parseDate(comment.updatedAt) ?? parseDate(comment.createdAt)
}

function collectReviewEvents(comments: PRStatusComment[]): ReviewEvent[] {
  const events: ReviewEvent[] = []
  for (const comment of comments) {
    const annotation = parseLatestCrosscheckAnnotation(comment.body)
    const at = commentCreatedAt(comment)
    if (!annotation?.verdict || !at) continue
    if (annotation.type === 'review' || annotation.type === 'recheck') {
      events.push({ type: annotation.type, verdict: annotation.verdict, at })
      continue
    }
    if (!annotation.type && annotation.reviewer) {
      events.push({
        type: comment.body.startsWith('> Recheck of') ? 'recheck' : 'review',
        verdict: annotation.verdict,
        at,
      })
    }
  }
  return events.sort((a, b) => a.at.getTime() - b.at.getTime())
}

function collectCommentFixEvents(comments: PRStatusComment[]): FixEvent[] {
  const events: FixEvent[] = []
  for (const comment of comments) {
    const annotation = parseLatestCrosscheckAnnotation(comment.body)
    const at = commentCreatedAt(comment)
    if (!annotation || !at) continue
    if (annotation.marker === 'fix_applied') events.push({ at, complete: true })
  }
  return events
}

function isFixStartedEvent(event: PRStatusLogEvent): boolean {
  return event.event === 'fix_started'
    || (event.event === 'step_started' && (event.step_type === 'fix' || event.type === 'fix'))
}

function collectLogFixEvents(logEvents: PRStatusLogEvent[]): FixEvent[] {
  return logEvents.flatMap((event): FixEvent[] => {
    const at = parseDate(event.ts)
    if (!at) return []
    if (event.event === 'fix_complete') {
      return [{
        at,
        appliedCount: typeof event.applied_count === 'number' ? event.applied_count : undefined,
        tokens: typeof event.tokens_used === 'number' ? event.tokens_used : undefined,
        complete: true,
      }]
    }
    if (isFixStartedEvent(event)) return [{ at, complete: false }]
    return []
  }).sort((a, b) => a.at.getTime() - b.at.getTime())
}

function collectProgress(reviewEvents: ReviewEvent[], fixEvents: FixEvent[]): PRProgressStep[] {
  const steps: PRProgressStep[] = [
    ...reviewEvents.map((event, index): PRProgressStep => ({
      kind: event.type === 'review' && index === 0 ? 'cr' : 'recheck',
      at: event.at,
      verdict: event.verdict,
    })),
    ...fixEvents.filter(event => event.complete).map((event): PRProgressStep => ({
      kind: 'fix',
      at: event.at,
      appliedCount: event.appliedCount,
      tokens: event.tokens,
    })),
  ]
  return steps.sort((a, b) => a.at.getTime() - b.at.getTime())
}

function relevantLogEvents(pr: PRStatusPullRequest, logEvents: PRStatusLogEvent[]): PRStatusLogEvent[] {
  const key = prKey(pr.owner, pr.repo, pr.number)
  return logEvents.filter(event => logEventKey(event) === key)
}

function relevantLogDate(event: PRStatusLogEvent): Date | null {
  if (
    event.event === 'review_complete'
    || event.event === 'fix_complete'
    || event.event === 'conflict_resolve_complete'
    || event.event === 'comment_posted'
    || event.event === 'pr_received'
    || event.event === 'pr_skipped'
    || isFixStartedEvent(event)
  ) {
    return parseDate(event.ts)
  }
  return null
}

export function computeTokenTotals(logEvents: PRStatusLogEvent[]): TokenTotals {
  const totals: TokenTotals = { byPR: {}, byPRHeadSha: {} }
  for (const event of logEvents) {
    const key = logEventKey(event)
    const tokens = typeof event.tokens_used === 'number' ? event.tokens_used : 0
    if (!key || tokens <= 0) continue

    const kind = event.event === 'fix_complete'
      ? 'fix'
      : event.event === 'review_complete' && (event.step_type === 'recheck' || event.type === 'recheck')
        ? 'recheck'
        : event.event === 'review_complete'
          ? 'review'
          : null
    if (!kind) continue

    totals.byPR[key] = cloneBucket(totals.byPR[key])
    addTokens(totals.byPR[key], kind, tokens)

    const sha = logEventSha(event)
    if (sha) {
      const shaKey = `${key}@${sha}`
      totals.byPRHeadSha[shaKey] = cloneBucket(totals.byPRHeadSha[shaKey])
      addTokens(totals.byPRHeadSha[shaKey], kind, tokens)
    }
  }
  return totals
}

export function computeLastActive(
  pr: PRStatusPullRequest,
  comments: PRStatusComment[],
  logEvents: PRStatusLogEvent[],
): Date {
  let latest = parseDate(pr.updatedAt) ?? parseDate(pr.createdAt)

  // Include ALL comments (not just crosscheck-annotated ones) so that normal
  // reviewer replies correctly reset the staleness clock.
  for (const comment of comments) {
    latest = maxDate(latest, commentDate(comment))
  }

  for (const event of relevantLogEvents(pr, logEvents)) {
    latest = maxDate(latest, relevantLogDate(event))
  }
  for (const commit of pr.commits ?? []) {
    latest = maxDate(latest, parseDate(commit.committedAt))
  }
  for (const status of pr.commitStatuses ?? []) {
    latest = maxDate(latest, parseDate(status.updatedAt))
  }

  return latest ?? new Date(0)
}

export function foldPRStatus(
  pr: PRStatusPullRequest,
  comments: PRStatusComment[],
  logEvents: PRStatusLogEvent[],
): PRStatus {
  const logsForPR = relevantLogEvents(pr, logEvents)
  const reviewEvents = collectReviewEvents(comments)
  const fixEvents = [...collectCommentFixEvents(comments), ...collectLogFixEvents(logsForPR)]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
  const latestReview = reviewEvents.at(-1)
  const latestFixAfterReview = latestReview
    ? fixEvents.filter(event => event.at.getTime() > latestReview.at.getTime()).at(-1)
    : undefined

  let state: PRReviewState = 'PR'
  let nextAction: PRNextAction = 'review'
  const verdict = latestReview?.verdict ?? null

  if (latestReview) {
    if (latestReview.verdict === 'APPROVE') {
      state = 'APPROVE'
      nextAction = 'none'
    } else if (latestFixAfterReview?.complete) {
      state = 'RECHECK'
      nextAction = 'recheck'
    } else if (latestFixAfterReview && !latestFixAfterReview.complete) {
      state = 'FIX'
      nextAction = 'fix'
    } else {
      state = latestReview.verdict
      nextAction = 'fix'
    }
  }

  const totals = computeTokenTotals(logsForPR)
  const key = prKey(pr.owner, pr.repo, pr.number)

  return {
    pr,
    state,
    nextAction,
    verdict,
    lastActive: computeLastActive(pr, comments, logEvents),
    tokenTotals: cloneBucket(totals.byPR[key]),
    progress: collectProgress(reviewEvents, fixEvents),
  }
}

export function isStale(status: PRStatus, staleAfter: number): boolean {
  return Date.now() - status.lastActive.getTime() > staleAfter
}

function formatTokens(tokens: number | undefined): string | null {
  if (tokens === undefined || tokens <= 0) return null
  if (tokens < 1000) return String(tokens)
  const rounded = Math.round(tokens / 100) / 10
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}K`
}

// Renders a human-readable timeline of up to 2 fix cycles and 2 rechecks.
// Steps beyond that cap are counted and surfaced as a trailing "+N more" marker
// so readers know the timeline is not complete.
export function buildProgressSummary(status: PRStatus): string {
  const parts = ['PR']
  let fixCount = 0
  let recheckCount = 0
  let sawCR = false
  let skipped = 0

  for (const step of status.progress) {
    if (step.kind === 'cr') {
      if (sawCR || !step.verdict) continue
      parts.push(`CR(${step.verdict})`)
      sawCR = true
      continue
    }
    if (step.kind === 'fix') {
      if (fixCount >= 2) { skipped++; continue }
      fixCount++
      const count = step.appliedCount ?? 0
      const tokens = formatTokens(step.tokens)
      parts.push(tokens ? `Fix(${count}, ${tokens})` : `Fix(${count})`)
      continue
    }
    if (step.kind === 'recheck') {
      if (recheckCount >= 2) { skipped++; continue }
      if (!step.verdict) continue
      recheckCount++
      parts.push(`Recheck(${step.verdict})`)
    }
  }

  if (skipped > 0) parts.push(`+${skipped} more`)

  return parts.join(' -> ')
}
