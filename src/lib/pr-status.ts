import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { Config } from '../config/schema.js'
import {
  createGithubClient,
  listCheckRuns,
  listCommitStatuses,
  listIssueComments,
  listOpenPRs,
  listOrgRepos,
  listPRCommitActivity,
  listPRReviewComments,
  listTimelineEvents,
  listUserRepos,
  type CommitStatusDetail,
  type OpenPR,
} from '../github/client.js'
import { getPRMergeSummary } from '../github/merge.js'
import { isAuthorAllowed } from './filter.js'
import { getLogDir } from './logger.js'
import { dedupScopes, type Scope } from './scopes.js'

export type Freshness = 'stale' | 'not_stale'
export type ReviewState = 'PR' | 'APPROVE' | 'NEEDS_WORK' | 'BLOCK' | 'FIX' | 'RECHECK'
export type NextAction = 'review' | 'run' | 'recheck' | null
export type CrosscheckVerdict = 'APPROVE' | 'NEEDS_WORK' | 'BLOCK'

export interface CrosscheckAnnotation {
  marker: string
  origin?: string
  reviewer?: string
  verdict?: CrosscheckVerdict
  type?: string
}

export interface PRActivityComment {
  body: string
  createdAt: string
  updatedAt?: string
}

export interface PRActivityCommit {
  sha: string
  committedAt: string
}

export interface PRActivityTimestamp {
  state?: string
  name?: string
  conclusion?: string | null
  status?: string | null
  updatedAt: string
}

export interface PRWorkflowLogEvent {
  ts: string
  event: string
  repo?: string
  pr?: number
  verdict?: string | null
  applied_count?: number
  conflicts_resolved?: number
  last_verdict?: string | null
  [key: string]: unknown
}

export interface PRStatusInput {
  owner: string
  repo: string
  number: number
  title: string
  author: string
  url: string
  headSha: string
  headRef: string
  baseRef: string
  prUpdatedAt: string
  comments: PRActivityComment[]
  reviewComments: PRActivityComment[]
  commits: PRActivityCommit[]
  commitStatuses: CommitStatusDetail[]
  checkRuns: PRActivityTimestamp[]
  timelineEvents: PRActivityTimestamp[]
  logEvents: PRWorkflowLogEvent[]
  merge?: PRMergeSummary
}

export interface PRMergeSummary {
  mergeable: boolean | null
  mergeStateStatus?: string
  protectedBase: boolean | null
}

export interface PRStatus {
  owner: string
  repo: string
  number: number
  title: string
  author: string
  url: string
  headSha: string
  headRef: string
  baseRef: string
  freshness: Freshness
  reviewState: ReviewState
  nextAction: NextAction
  lastActiveAt: string
  staleAfterMs: number
  ageMs: number
  verdict: CrosscheckVerdict | null
  latestAnnotation: CrosscheckAnnotation | null
  merge?: PRMergeSummary
}

export interface ScanSummary {
  total: number
  stale: number
  not_stale: number
  actionable: number
}

export interface ScanResult {
  scannedAt: string
  staleAfterMs: number
  cached: boolean
  summary: ScanSummary
  prs: PRStatus[]
}

export interface DeriveStatusOptions {
  nowMs: number
  staleAfterMs: number
}

export interface ScanOpenPRStatusesOptions {
  now?: Date
  staleAfterMs: number
}

interface TimedAnnotation {
  annotation: CrosscheckAnnotation
  timestamp: string
}

interface TimedVerdict {
  verdict: CrosscheckVerdict
  timestamp: string
  annotation: CrosscheckAnnotation | null
}

const WORKFLOW_ACTIVITY_EVENTS = new Set([
  'review_complete',
  'fix_complete',
  'conflict_resolve_complete',
  'workflow_complete',
  'step_skipped',
  'comment_posted',
])

export function parseCrosscheckAnnotation(body: string): CrosscheckAnnotation | null {
  const matches = [...body.matchAll(/<!--\s*crosscheck:\s*([^>]+?)\s*-->/g)]
  const last = matches.at(-1)
  if (!last) return null

  const raw = last[1].trim()
  const parts = raw.split(/\s+/).filter(Boolean)
  const attrs = new Map<string, string>()
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    attrs.set(part.slice(0, eq), part.slice(eq + 1))
  }

  const first = parts[0] ?? 'unknown'
  const marker = first.includes('=') ? first.slice(0, first.indexOf('=')) : first
  const verdict = normalizeVerdict(attrs.get('verdict'))
  return {
    marker,
    ...(attrs.has('origin') && { origin: attrs.get('origin') }),
    ...(attrs.has('reviewer') && { reviewer: attrs.get('reviewer') }),
    ...(verdict && { verdict }),
    ...(attrs.has('type') && { type: attrs.get('type') }),
  }
}

export function derivePRStatus(input: PRStatusInput, options: DeriveStatusOptions): PRStatus {
  const latestAnnotation = latestTimedAnnotation([...input.comments, ...input.reviewComments])
  const latestVerdict = latestTimedVerdict(input, latestAnnotation)
  const latestFix = latestAppliedFixAfter(input.logEvents, latestVerdict?.timestamp)
  const lastActiveMs = maxTimestampMs([
    input.prUpdatedAt,
    ...input.comments.flatMap(comment => [comment.createdAt, comment.updatedAt]),
    ...input.reviewComments.flatMap(comment => [comment.createdAt, comment.updatedAt]),
    ...input.commits.map(commit => commit.committedAt),
    ...input.commitStatuses.map(status => status.updatedAt),
    ...input.checkRuns.map(run => run.updatedAt),
    ...input.timelineEvents.map(event => event.updatedAt),
    ...input.logEvents.filter(event => WORKFLOW_ACTIVITY_EVENTS.has(event.event)).map(event => event.ts),
  ]) ?? Date.parse(input.prUpdatedAt)

  const ageMs = Math.max(0, options.nowMs - lastActiveMs)
  const reviewState = computeReviewState(latestVerdict, latestFix)
  const nextAction = nextActionForState(reviewState)
  const freshness: Freshness = ageMs >= options.staleAfterMs && nextAction !== null ? 'stale' : 'not_stale'

  return {
    owner: input.owner,
    repo: input.repo,
    number: input.number,
    title: input.title,
    author: input.author,
    url: input.url,
    headSha: input.headSha,
    headRef: input.headRef,
    baseRef: input.baseRef,
    freshness,
    reviewState,
    nextAction,
    lastActiveAt: new Date(lastActiveMs).toISOString(),
    staleAfterMs: options.staleAfterMs,
    ageMs,
    verdict: latestVerdict?.verdict ?? null,
    latestAnnotation: latestAnnotation?.annotation ?? null,
    ...(input.merge && { merge: input.merge }),
  }
}

export function summarizeStatuses(prs: PRStatus[]): ScanSummary {
  return {
    total: prs.length,
    stale: prs.filter(pr => pr.freshness === 'stale').length,
    not_stale: prs.filter(pr => pr.freshness === 'not_stale').length,
    actionable: prs.filter(pr => pr.nextAction !== null).length,
  }
}

export async function scanOpenPRStatuses(
  config: Config,
  token: string,
  options: ScanOpenPRStatusesOptions,
): Promise<ScanResult> {
  const now = options.now ?? new Date()
  const [repoScopes, logEvents] = await Promise.all([
    buildRepoScopes(config, token),
    Promise.resolve(loadWorkflowLogEvents()),
  ])
  const octokit = createGithubClient(token)

  const perRepoPRs = await Promise.all(
    repoScopes.map(async ({ owner, repo }) => {
      try {
        const prs = await listOpenPRs(owner, repo, token)
        return prs
          .filter(pr => isAuthorAllowed(config.routing.allowed_authors, pr.author))
          .map(pr => ({ owner, repo, pr }))
      } catch {
        return [] as Array<{ owner: string; repo: string; pr: OpenPR }>
      }
    }),
  )

  const statuses = await Promise.all(
    perRepoPRs.flat().map(async ({ owner, repo, pr }) => {
      const [
        comments,
        reviewComments,
        commits,
        commitStatuses,
        checkRuns,
        timelineEvents,
        merge,
      ] = await Promise.all([
        listIssueComments(owner, repo, pr.number, token),
        listPRReviewComments(owner, repo, pr.number, token),
        listPRCommitActivity(owner, repo, pr.number, token),
        listCommitStatuses(owner, repo, pr.headSha, token),
        listCheckRuns(owner, repo, pr.headSha, token),
        listTimelineEvents(owner, repo, pr.number, token),
        getPRMergeSummary(octokit, owner, repo, pr.number, pr.baseRef),
      ])

      return derivePRStatus({
        owner,
        repo,
        number: pr.number,
        title: pr.title,
        author: pr.author,
        url: pr.url ?? `https://github.com/${owner}/${repo}/pull/${pr.number}`,
        headSha: pr.headSha,
        headRef: pr.headRef,
        baseRef: pr.baseRef,
        prUpdatedAt: pr.updatedAt ?? pr.createdAt,
        comments,
        reviewComments,
        commits,
        commitStatuses,
        checkRuns,
        timelineEvents,
        logEvents: filterLogEventsForPR(logEvents, owner, repo, pr.number),
        merge,
      }, { nowMs: now.getTime(), staleAfterMs: options.staleAfterMs })
    }),
  )

  statuses.sort((a, b) => {
    if (a.freshness !== b.freshness) return a.freshness === 'stale' ? -1 : 1
    return Date.parse(a.lastActiveAt) - Date.parse(b.lastActiveAt)
  })

  return {
    scannedAt: now.toISOString(),
    staleAfterMs: options.staleAfterMs,
    cached: false,
    summary: summarizeStatuses(statuses),
    prs: statuses,
  }
}

export function loadWorkflowLogEvents(logDir = getLogDir()): PRWorkflowLogEvent[] {
  if (!existsSync(logDir)) return []
  const files = readdirSync(logDir)
    .filter(file => file.endsWith('.ndjson'))
    .sort()
    .map(file => join(logDir, file))

  return files.flatMap(file => parseLogFile(file))
}

export function filterLogEventsForPR(
  events: PRWorkflowLogEvent[],
  owner: string,
  repo: string,
  pr: number,
): PRWorkflowLogEvent[] {
  const fullName = `${owner}/${repo}`
  return events.filter(event => event.repo === fullName && event.pr === pr)
}

function parseLogFile(path: string): PRWorkflowLogEvent[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .flatMap(line => {
      try {
        const parsed = JSON.parse(line) as unknown
        return isWorkflowLogEvent(parsed) ? [parsed] : []
      } catch {
        return []
      }
    })
}

function isWorkflowLogEvent(value: unknown): value is PRWorkflowLogEvent {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.ts === 'string' && typeof record.event === 'string'
}

// Use createdAt for ordering annotation timestamps — updatedAt would flip verdict
// ordering if an older comment is edited after a newer one is posted.
function latestTimedAnnotation(comments: PRActivityComment[]): TimedAnnotation | null {
  const timed = comments.flatMap(comment => {
    const annotation = parseCrosscheckAnnotation(comment.body)
    if (!annotation) return []
    return [{ annotation, timestamp: comment.createdAt }]
  })
  return timed.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0] ?? null
}

function latestTimedVerdict(input: PRStatusInput, latestAnnotation: TimedAnnotation | null): TimedVerdict | null {
  const annotationVerdicts = latestAnnotation?.annotation.verdict
    ? [{
        verdict: latestAnnotation.annotation.verdict,
        timestamp: latestAnnotation.timestamp,
        annotation: latestAnnotation.annotation,
      }]
    : []

  const logVerdicts = input.logEvents.flatMap(event => {
    if (event.event !== 'review_complete' && event.event !== 'workflow_complete') return []
    const verdict = normalizeVerdict(event.verdict ?? event.last_verdict)
    return verdict ? [{ verdict, timestamp: event.ts, annotation: null }] : []
  })

  return [...annotationVerdicts, ...logVerdicts]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0] ?? null
}

function latestAppliedFixAfter(events: PRWorkflowLogEvent[], after: string | undefined): PRWorkflowLogEvent | null {
  const afterMs = after ? Date.parse(after) : 0
  return events
    .filter(event => Date.parse(event.ts) > afterMs)
    .filter(event => {
      if (event.event === 'fix_complete') return typeof event.applied_count === 'number' && event.applied_count > 0
      if (event.event === 'conflict_resolve_complete') return typeof event.conflicts_resolved === 'number' && event.conflicts_resolved > 0
      return false
    })
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0] ?? null
}

function computeReviewState(latestVerdict: TimedVerdict | null, latestFix: PRWorkflowLogEvent | null): ReviewState {
  if (!latestVerdict) return 'PR'
  if (latestFix) return 'RECHECK'
  return latestVerdict.verdict
}

function nextActionForState(state: ReviewState): NextAction {
  if (state === 'PR') return 'review'
  if (state === 'RECHECK') return 'recheck'
  if (state === 'NEEDS_WORK' || state === 'BLOCK' || state === 'FIX') return 'run'
  return null
}

function maxTimestampMs(values: Array<string | undefined>): number | null {
  const timestamps = values
    .filter((value): value is string => typeof value === 'string')
    .map(value => Date.parse(value))
    .filter(value => Number.isFinite(value))
  if (timestamps.length === 0) return null
  return Math.max(...timestamps)
}

function normalizeVerdict(value: unknown): CrosscheckVerdict | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toUpperCase().replace(/\s+/g, '_')
  if (normalized === 'APPROVE' || normalized === 'NEEDS_WORK' || normalized === 'BLOCK') return normalized
  return null
}

async function buildRepoScopes(config: Config, token: string): Promise<Array<{ owner: string; repo: string }>> {
  const userScopes = await Promise.all(
    config.users.map(async (user) => {
      try {
        const repos = await listUserRepos(user, token)
        return repos.map(({ owner, name }) => ({ owner, repo: name }) as Scope)
      } catch {
        return [] as Scope[]
      }
    }),
  )

  const rawScopes: Scope[] = [
    ...config.orgs.map(org => ({ org }) as Scope),
    ...config.repos.map(repo => ({ owner: repo.owner, repo: repo.name }) as Scope),
    ...userScopes.flat(),
  ]

  const deduped = dedupScopes(rawScopes).scopes
  const expanded = await Promise.all(
    deduped.map(async (scope) => {
      if ('org' in scope) {
        try {
          const repos = await listOrgRepos(scope.org, token)
          return repos.map(repo => ({ owner: repo.owner, repo: repo.name }))
        } catch {
          return [] as Array<{ owner: string; repo: string }>
        }
      }
      return [{ owner: scope.owner, repo: scope.repo }]
    }),
  )

  const byKey = new Map<string, { owner: string; repo: string }>()
  for (const repo of expanded.flat()) {
    byKey.set(`${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}`, repo)
  }
  return [...byKey.values()]
}
