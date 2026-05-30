import chalk from 'chalk'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { loadConfig, resolveConfigPath, getGithubToken, detectGitHubLogin } from '../config/loader.js'
import type { Config } from '../config/schema.js'
import {
  listIssueCommentsForScan,
  listOpenPRsForScan,
  listOrgReposForScan,
  listUserReposForScan,
  type ScanIssueComment,
  type ScanOpenPR,
  type ScanRepo,
} from '../github/client.js'
import { formatElapsed, parseDurationMs } from '../lib/durations.js'
import { getLogDir } from '../lib/logger.js'
import { buildMonitorScopeHash, buildScanCacheKey, readScanCache, writeScanCache } from '../lib/scan-cache.js'
import { isAuthorAllowed } from '../lib/filter.js'

type ReviewState = 'PR' | 'APPROVE' | 'NEEDS_WORK' | 'BLOCK'
type StepType = 'review' | 'fix' | 'recheck'

export interface ScanTokens {
  review: number
  fix: number
  recheck: number
  total: number
}

export interface ScanAnnotationMetadata {
  commentId: number
  commentCreatedAt: string
  raw: string
  origin?: string
  reviewer?: string
  verdict?: ReviewState
  type?: string
  // true when the comment has a "> Recheck of" prefix — covers pre-type-era
  // annotations that lack an explicit type= field in the tag.
  isRecheck?: boolean
}

export interface ScanRow {
  repo: string
  pr: number
  title: string
  author: string
  branch: string
  headSha: string
  headShaShort: string
  url: string
  createdAt: string
  lastActiveAt: string
  isStale: boolean
  reviewState: ReviewState
  latestVerdict: ReviewState | null
  progressSummary: string
  tokens: ScanTokens
  latestAnnotation: ScanAnnotationMetadata | null
  nextAction: string | null
}

export interface SkippedRepo {
  repo: string
  reason: string
}

interface ScanPayload {
  generatedAt: string
  staleAfterMs: number
  rows: ScanRow[]
  skippedRepos: SkippedRepo[]
}

interface ScanOptions {
  config?: string
  staleAfter?: string
  tidy?: boolean
  json?: boolean
  force?: boolean
}

export interface LogEntry {
  ts: string
  event: string
  repo?: string
  pr?: number
  step_type?: string
  verdict?: string | null
  tokens_used?: number
  applied_count?: number
  conflicts_resolved?: number
  reason?: string
}

export interface PRLogSummary {
  reviewVerdict: ReviewState | null
  recheckVerdict: ReviewState | null
  latestVerdict: ReviewState | null
  latestVerdictAt: string | null
  latestStep: StepType | null
  latestLogAt: string | null
  fixAppliedCount: number | null
  fixCompletedAt: string | null
  tokens: ScanTokens
}

const DEFAULT_STALE_AFTER = '24h'
const STATE_ORDER: ReviewState[] = ['NEEDS_WORK', 'BLOCK', 'APPROVE', 'PR']
const SCAN_REPO_CONCURRENCY = 8
const SCAN_PR_CONCURRENCY = 4

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      results[idx] = await fn(items[idx])
    }
  })
  await Promise.all(workers)
  return results
}

export async function runScan(opts: ScanOptions): Promise<void> {
  try {
    const staleAfterMs = parseDurationMs(opts.staleAfter ?? DEFAULT_STALE_AFTER)
    const configPath = resolveConfigPath(opts.config)
    const config = loadConfig(opts.config)
    const githubLogin = detectGitHubLogin()
    const packageVersion = readPackageVersion()
    const monitorScopeHash = buildMonitorScopeHash({
      orgs: config.orgs,
      users: config.users,
      repos: config.repos,
      allowed_authors: config.routing.allowed_authors,
    })
    const cacheKey = buildScanCacheKey({ configPath, monitorScopeHash, githubLogin, staleAfterMs, packageVersion })
    const cached = readScanCache<ScanPayload>(cacheKey, { force: opts.force })

    const payload = cached ?? await collectScanPayload(config, staleAfterMs, githubLogin)
    if (cached === null) {
      writeScanCache(cacheKey, payload, { partialFailure: payload.skippedRepos.length > 0 })
    }

    const outputPayload = {
      ...payload,
      rows: filterScanRowsForOutput(payload.rows, opts.tidy === true),
    }

    if (opts.json === true) {
      console.log(JSON.stringify({ ...outputPayload, cache: { hit: cached !== null } }, null, 2))
      return
    }

    renderScan(outputPayload, { cacheHit: cached !== null })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(chalk.red(message))
    process.exit(1)
  }
}

export function filterScanRowsForOutput(rows: ScanRow[], tidy: boolean): ScanRow[] {
  if (!tidy) return rows
  return rows.filter(row => row.isStale && row.nextAction !== null)
}

async function collectScanPayload(config: Config, staleAfterMs: number, githubLogin: string | null): Promise<ScanPayload> {
  const token = getGithubToken()
  const skippedRepos: SkippedRepo[] = []
  const repos = await expandConfiguredRepos(config, token, githubLogin, skippedRepos)
  const logIndex = readLogIndex()
  const now = Date.now()

  const perRepoRows = await mapWithConcurrency(repos, SCAN_REPO_CONCURRENCY, async (repo) => {
    let prs: Awaited<ReturnType<typeof listOpenPRsForScan>>
    try {
      prs = await listOpenPRsForScan(repo.owner, repo.name, token)
    } catch (err) {
      skippedRepos.push({ repo: `${repo.owner}/${repo.name}`, reason: conciseReason(err) })
      return [] as ScanRow[]
    }
    const allowedPRs = prs.filter(pr => isAuthorAllowed(config.routing.allowed_authors, pr.author))
    // Catch per-PR so a flaky comment fetch on one PR doesn't drop the rest
    const rows = await mapWithConcurrency(allowedPRs, SCAN_PR_CONCURRENCY, async (pr) => {
      try {
        return await buildScanRow(repo, pr, token, logIndex, staleAfterMs, now)
      } catch (err) {
        skippedRepos.push({ repo: `${repo.owner}/${repo.name}#${pr.number}`, reason: conciseReason(err) })
        return null
      }
    })
    return rows.filter((r): r is ScanRow => r !== null)
  })

  const rows = perRepoRows.flat().sort((a, b) => {
    if (a.isStale !== b.isStale) return a.isStale ? -1 : 1
    const stateDiff = STATE_ORDER.indexOf(a.reviewState) - STATE_ORDER.indexOf(b.reviewState)
    if (stateDiff !== 0) return stateDiff
    return new Date(a.lastActiveAt).getTime() - new Date(b.lastActiveAt).getTime()
  })

  return {
    generatedAt: new Date(now).toISOString(),
    staleAfterMs,
    rows,
    skippedRepos: skippedRepos.sort((a, b) => a.repo.localeCompare(b.repo)),
  }
}

async function expandConfiguredRepos(
  config: Config,
  token: string,
  githubLogin: string | null,
  skippedRepos: SkippedRepo[],
): Promise<ScanRepo[]> {
  const repoMap = new Map<string, ScanRepo>()
  const addRepo = (repo: ScanRepo): void => {
    // Case-insensitive key so Acme/api and acme/api don't produce duplicate rows
    repoMap.set(`${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`, repo)
  }

  for (const repo of config.repos) addRepo({ owner: repo.owner, name: repo.name })

  const orgResults = await Promise.all(config.orgs.map(async (org) => {
    try {
      return await listOrgReposForScan(org, token)
    } catch (err) {
      skippedRepos.push({ repo: org, reason: conciseReason(err) })
      return [] as ScanRepo[]
    }
  }))
  for (const repo of orgResults.flat()) addRepo(repo)

  const userResults = await Promise.all(config.users.map(async (user) => {
    try {
      return await listUserReposForScan(user, token, sameGitHubLogin(user, githubLogin))
    } catch (err) {
      skippedRepos.push({ repo: user, reason: conciseReason(err) })
      return [] as ScanRepo[]
    }
  }))
  for (const repo of userResults.flat()) addRepo(repo)

  return [...repoMap.values()].sort((a, b) => `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`))
}

async function buildScanRow(
  repo: ScanRepo,
  pr: ScanOpenPR,
  token: string,
  logIndex: Map<string, PRLogSummary>,
  staleAfterMs: number,
  now: number,
): Promise<ScanRow> {
  const repoName = `${repo.owner}/${repo.name}`
  const comments = await listIssueCommentsForScan(repo.owner, repo.name, pr.number, token)
  const { latestAnnotation, latestVerdictAnnotation } = findLatestAnnotation(comments)
  const logSummary = logIndex.get(`${repoName}#${pr.number}`) ?? emptyLogSummary()

  const latestVerdict = latestVerdictAnnotation?.verdict
    ? chooseLatestVerdict(latestVerdictAnnotation.verdict, latestVerdictAnnotation.commentCreatedAt, logSummary)
    : logSummary.latestVerdict
  const reviewState = latestVerdict ?? 'PR'
  const lastActiveAt = maxTimestamp([pr.updatedAt, latestAnnotation?.commentCreatedAt, logSummary.latestLogAt]) ?? pr.createdAt
  const isStale = now - new Date(lastActiveAt).getTime() >= staleAfterMs
  const progressSummary = buildProgressSummary(latestVerdictAnnotation, logSummary)

  return {
    repo: repoName,
    pr: pr.number,
    title: pr.title,
    author: pr.author,
    branch: pr.headRef,
    headSha: pr.headSha,
    headShaShort: pr.headSha.slice(0, 7),
    url: pr.url,
    createdAt: pr.createdAt,
    lastActiveAt,
    isStale,
    reviewState,
    latestVerdict,
    progressSummary,
    tokens: logSummary.tokens,
    latestAnnotation,
    nextAction: selectNextAction(latestVerdict, logSummary),
  }
}

export function chooseLatestVerdict(
  annotationVerdict: ReviewState,
  annotationAt: string,
  logSummary: PRLogSummary,
): ReviewState | null {
  if (!logSummary.latestVerdictAt) return annotationVerdict
  return new Date(annotationAt).getTime() >= new Date(logSummary.latestVerdictAt).getTime()
    ? annotationVerdict
    : logSummary.latestVerdict
}

export function selectNextAction(latestVerdict: ReviewState | null, logSummary: PRLogSummary): string | null {
  if (!latestVerdict || latestVerdict === 'PR') return 'next CR'
  if (latestVerdict === 'APPROVE') return 'next merge'
  if (latestVerdict === 'NEEDS_WORK' || latestVerdict === 'BLOCK') {
    if (logSummary.latestStep === 'fix') return 'next recheck'
    return 'next fix'
  }
  return null
}

export function buildProgressSummary(annotation: ScanAnnotationMetadata | null, logSummary: PRLogSummary): string {
  const parts = ['PR']
  if (logSummary.reviewVerdict) {
    parts.push(`CR(${logSummary.reviewVerdict})`)
  } else if (annotation?.verdict) {
    parts.push(`${annotation.isRecheck ? 'recheck' : 'CR'}(${annotation.verdict})`)
  }
  if (logSummary.fixAppliedCount !== null) parts.push(`fix(${logSummary.fixAppliedCount})`)
  const recheckVerdict = logSummary.recheckVerdict
  if (recheckVerdict) parts.push(`recheck(${recheckVerdict})`)
  return parts.join(' -> ')
}

interface ScanAnnotations {
  latestAnnotation: ScanAnnotationMetadata | null
  latestVerdictAnnotation: ScanAnnotationMetadata | null
}

export function findLatestAnnotation(comments: ScanIssueComment[]): ScanAnnotations {
  let latestAnnotation: ScanAnnotationMetadata | null = null
  let latestVerdictAnnotation: ScanAnnotationMetadata | null = null
  const orderedComments = [...comments].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  )
  for (const comment of orderedComments) {
    const matches = [...comment.body.matchAll(/<!-- crosscheck: ([^>]+) -->/g)]
    const match = matches.at(-1)
    if (!match) continue

    const attrs = parseAttrs(match[1])
    const annotation: ScanAnnotationMetadata = {
      commentId: comment.id,
      commentCreatedAt: comment.createdAt,
      raw: match[1],
      origin: attrs.origin,
      reviewer: attrs.reviewer,
      verdict: normalizeReviewState(attrs.verdict) ?? undefined,
      type: attrs.type,
      isRecheck: attrs.type === 'recheck' || comment.body.startsWith('> Recheck of'),
    }
    latestAnnotation = annotation
    if (annotation.verdict) latestVerdictAnnotation = annotation
  }
  return { latestAnnotation, latestVerdictAnnotation }
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const part of raw.trim().split(/\s+/)) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    attrs[part.slice(0, eq)] = part.slice(eq + 1)
  }
  return attrs
}

function readLogIndex(): Map<string, PRLogSummary> {
  const index = new Map<string, PRLogSummary>()
  const logDir = getLogDir()
  if (!existsSync(logDir)) return index

  const files = readdirSync(logDir).filter(file => file.endsWith('.ndjson')).sort().map(file => join(logDir, file))
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      const entry = parseLogEntry(line)
      if (!entry?.repo || typeof entry.pr !== 'number') continue
      const key = `${entry.repo}#${entry.pr}`
      const summary = index.get(key) ?? emptyLogSummary()
      applyLogEntry(summary, entry)
      index.set(key, summary)
    }
  }
  return index
}

function parseLogEntry(line: string): LogEntry | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>
    return {
      ts: typeof parsed.ts === 'string' ? parsed.ts : '',
      event: typeof parsed.event === 'string' ? parsed.event : '',
      repo: typeof parsed.repo === 'string' ? parsed.repo : undefined,
      pr: typeof parsed.pr === 'number' ? parsed.pr : undefined,
      step_type: typeof parsed.step_type === 'string' ? parsed.step_type : undefined,
      verdict: typeof parsed.verdict === 'string' || parsed.verdict === null ? parsed.verdict : undefined,
      tokens_used: finiteNumber(parsed.tokens_used),
      applied_count: finiteNumber(parsed.applied_count),
      conflicts_resolved: finiteNumber(parsed.conflicts_resolved),
      reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
    }
  } catch {
    return null
  }
}

function sameGitHubLogin(configUser: string, githubLogin: string | null): boolean {
  return githubLogin !== null && configUser.toLowerCase() === githubLogin.toLowerCase()
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function applyLogEntry(summary: PRLogSummary, entry: LogEntry): void {
  if (entry.ts) summary.latestLogAt = maxTimestamp([summary.latestLogAt, entry.ts])

  if (entry.event === 'review_complete') {
    const verdict = normalizeReviewState(entry.verdict ?? undefined)
    const stepType: 'review' | 'recheck' = entry.step_type === 'recheck' ? 'recheck' : 'review'
    if (stepType === 'recheck') summary.recheckVerdict = verdict
    else summary.reviewVerdict = verdict
    if (verdict) {
      summary.latestVerdict = verdict
      summary.latestVerdictAt = entry.ts
      summary.latestStep = stepType
    }
    addTokens(summary.tokens, stepType, entry.tokens_used)
  } else if (entry.event === 'fix_complete') {
    if (entry.applied_count !== undefined) summary.fixAppliedCount = entry.applied_count
    summary.fixCompletedAt = entry.ts
    summary.latestStep = 'fix'
    addTokens(summary.tokens, 'fix', entry.tokens_used)
  } else if (entry.event === 'conflict_resolve_complete') {
    if (entry.conflicts_resolved !== undefined) summary.fixAppliedCount = entry.conflicts_resolved
    summary.fixCompletedAt = entry.ts
    summary.latestStep = 'fix'
    addTokens(summary.tokens, 'fix', entry.tokens_used)
  }
}

function addTokens(tokens: ScanTokens, step: StepType, value: number | undefined): void {
  if (value === undefined) return
  tokens[step] += value
  tokens.total += value
}

export function emptyLogSummary(): PRLogSummary {
  return {
    reviewVerdict: null,
    recheckVerdict: null,
    latestVerdict: null,
    latestVerdictAt: null,
    latestStep: null,
    latestLogAt: null,
    fixAppliedCount: null,
    fixCompletedAt: null,
    tokens: { review: 0, fix: 0, recheck: 0, total: 0 },
  }
}

function normalizeReviewState(value: string | undefined | null): ReviewState | null {
  if (!value) return null
  const normalized = value.toUpperCase().replace(/\s+/g, '_')
  if (normalized === 'APPROVE') return 'APPROVE'
  if (normalized === 'NEEDS_WORK') return 'NEEDS_WORK'
  if (normalized === 'BLOCK') return 'BLOCK'
  return null
}

function maxTimestamp(values: Array<string | null | undefined>): string | null {
  let latest: string | null = null
  for (const value of values) {
    if (!value) continue
    if (Number.isNaN(new Date(value).getTime())) continue
    if (!latest || new Date(value).getTime() > new Date(latest).getTime()) latest = value
  }
  return latest
}

function renderScan(payload: ScanPayload, opts: { cacheHit: boolean }): void {
  const rows = payload.rows
  const now = Date.parse(payload.generatedAt)
  console.log(chalk.bold(`\ncrosscheck scan`) + chalk.dim(`  stale after ${formatDuration(payload.staleAfterMs)}${opts.cacheHit ? ' - cached' : ''}`))

  if (rows.length === 0) {
    console.log(chalk.dim('\n  No open PRs in scope.\n'))
  } else {
    renderFreshnessGroup('STALE', rows.filter(row => row.isStale), now)
    renderFreshnessGroup('NOT STALE', rows.filter(row => !row.isStale), now)
  }

  if (payload.skippedRepos.length > 0) {
    console.log(chalk.yellow('\nSKIPPED REPOS'))
    for (const skipped of payload.skippedRepos) {
      console.log(`  ${skipped.repo}  ${chalk.dim(skipped.reason)}`)
    }
    console.log(chalk.dim('\n  Cache not updated because the scan had partial GitHub API failures.'))
  }
  console.log()
}

function renderFreshnessGroup(label: string, rows: ScanRow[], now: number): void {
  if (rows.length === 0) return
  console.log(`\n${chalk.bold(label)}`)
  for (const state of STATE_ORDER) {
    const stateRows = rows.filter(row => row.reviewState === state)
    if (stateRows.length === 0) continue
    console.log(`  ${state}`)
    for (const row of stateRows) {
      console.log(`    ${formatRow(row, now)}`)
    }
  }
}

function formatRow(row: ScanRow, now: number): string {
  return [
    `${row.repo}#${row.pr}`,
    truncate(row.title, 48),
    `@${row.author}`,
    row.branch,
    row.headShaShort,
    `verdict ${row.latestVerdict ?? '--'}`,
    row.progressSummary,
    `created ${formatElapsed(row.createdAt, now)}`,
    `last active ${formatElapsed(row.lastActiveAt, now)}`,
    `tokens ${formatTokens(row.tokens.total)}`,
    row.nextAction ?? 'no action',
    row.url,
  ].join('  ')
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`
}

function formatTokens(value: number): string {
  if (value <= 0) return '--'
  if (value >= 1000) return `${Math.round(value / 100) / 10}K`
  return String(value)
}

function formatDuration(ms: number): string {
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (ms % day === 0) return `${ms / day}d`
  if (ms % hour === 0) return `${ms / hour}h`
  return `${ms / minute}m`
}

function conciseReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/\s+/g, ' ').slice(0, 160)
}

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const pkg = JSON.parse(readFileSync(join(here, '../../package.json'), 'utf8')) as { version?: unknown }
  return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
}
