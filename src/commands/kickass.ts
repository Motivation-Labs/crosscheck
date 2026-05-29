import chalk from 'chalk'
import { createGithubClient, listOpenPRs, listOrgRepos, listPRComments, type PRComment } from '../github/client.js'
import { detectOriginFull, assignReviewer, type PROrigin } from '../github/detector.js'
import { mergePullRequest } from '../github/merge.js'
import { loadConfig, getGithubToken } from '../config/loader.js'
import { initLogger, log as fileLog, logError } from '../lib/logger.js'
import { isAuthorAllowed } from '../lib/filter.js'
import { buildScopesFromConfig, type BacktraceScope } from '../lib/backtrace.js'
import { promptPRPicker, type PRPickerItem } from '../lib/pr-picker.js'
import { runRun, type RunOpts } from './run.js'
import type { Config } from '../config/schema.js'

const SCAN_CACHE_MS = 60_000

export interface KickassOpts {
  config?: string
  force?: boolean
  dryRun?: boolean
}

export interface KickassScannedPR {
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
  comments: PRComment[]
  origin: PROrigin
  reviewer: 'claude' | 'codex' | null
}

export type KickassAction = 'review' | 'fix' | 'recheck' | 'merge'

export interface FreshReviewComment {
  id: number
  body: string
}

export interface KickassPlanItem {
  key: string
  pr: KickassScannedPR
  action: KickassAction
  transition: string
  scannedHeadSha: string
  reviewer?: 'claude' | 'codex'
  fixer?: 'claude' | 'codex' | 'auto'
  delivery?: string
  mergeMethod?: string
  checks?: string
  explanation?: string
  reviewComment?: FreshReviewComment
}

export interface KickassExecutionResult {
  executed: number
  skipped: Array<{ pr: string; reason: string }>
}

export interface KickassScanResult {
  candidates: KickassScannedPR[]
}

export interface KickassDeps {
  config?: Config
  token?: string
  scan?: (force: boolean) => Promise<KickassScanResult>
  pick?: (items: KickassPlanItem[]) => Promise<KickassPlanItem[]>
  confirm?: (items: KickassPlanItem[]) => Promise<boolean>
  run?: (item: KickassPlanItem, steps: string) => Promise<void>
  merge?: (item: KickassPlanItem) => Promise<void>
  getCurrentHead?: (item: KickassPlanItem) => Promise<{ sha: string; headRepo: string | null }>
  log?: (line: string) => void
}

interface CacheEntry {
  writtenAt: number
  result: KickassScanResult
}

interface ParsedAnnotation {
  type?: string
  verdict?: 'APPROVE' | 'NEEDS_WORK' | 'BLOCK'
  sha?: string
}

let scanCache: CacheEntry | null = null

function prLabel(pr: Pick<KickassScannedPR, 'owner' | 'repo' | 'number'>): string {
  return `${pr.owner}/${pr.repo}#${pr.number}`
}

function prUrl(pr: Pick<KickassScannedPR, 'owner' | 'repo' | 'number'>): string {
  return `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`
}

function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

function normalizeVerdict(value: string | undefined): ParsedAnnotation['verdict'] {
  if (value === 'APPROVE') return 'APPROVE'
  if (value === 'NEEDS_WORK' || value === 'NEEDS WORK') return 'NEEDS_WORK'
  if (value === 'BLOCK') return 'BLOCK'
  return undefined
}

function parseAnnotation(body: string): ParsedAnnotation | null {
  const matches = [...body.matchAll(/<!-- crosscheck: ([^>]+) -->/g)]
  const last = matches.at(-1)
  if (!last) return null

  const parsed: ParsedAnnotation = {}
  const attrs = last[1].trim().split(/\s+/)
  for (const attr of attrs) {
    if (attr === 'fix_applied' || attr === 'conflict_resolved') {
      parsed.type = attr
      continue
    }
    const [key, value] = attr.split('=')
    if (!key || value === undefined) continue
    if (key === 'type') parsed.type = value
    if (key === 'verdict') parsed.verdict = normalizeVerdict(value)
    if (key === 'sha') parsed.sha = value
  }
  return parsed
}

function isForkPR(pr: Pick<KickassScannedPR, 'owner' | 'repo' | 'headRepo'>): boolean {
  return pr.headRepo === null || pr.headRepo !== `${pr.owner}/${pr.repo}`
}

function findLatestFreshReviewComment(pr: KickassScannedPR): FreshReviewComment | null {
  const comments = [...pr.comments].reverse()
  for (const comment of comments) {
    const annotation = parseAnnotation(comment.body)
    if (!annotation) continue
    if (annotation.type !== 'review') continue
    if (annotation.sha !== pr.headSha) continue
    return { id: comment.id, body: comment.body }
  }
  return null
}

function latestCrosscheckState(pr: KickassScannedPR): ParsedAnnotation | null {
  const comments = [...pr.comments].reverse()
  for (const comment of comments) {
    const annotation = parseAnnotation(comment.body)
    if (annotation) return annotation
  }
  return null
}

function actionForPR(pr: KickassScannedPR, config: Config): Omit<KickassPlanItem, 'key' | 'pr' | 'scannedHeadSha'> {
  const latest = latestCrosscheckState(pr)
  if (!latest) {
    return {
      action: 'review',
      transition: 'PR -> CR',
      reviewer: pr.reviewer ?? undefined,
    }
  }

  if (latest.type === 'fix_applied' || latest.type === 'conflict_resolved') {
    return {
      action: 'recheck',
      transition: latest.type === 'fix_applied' ? 'FIX -> Recheck' : 'RECHECK -> Recheck',
      reviewer: pr.reviewer ?? undefined,
      reviewComment: findLatestFreshReviewComment(pr) ?? undefined,
    }
  }

  if ((latest.type === 'review' || latest.type === undefined) && (latest.verdict === 'NEEDS_WORK' || latest.verdict === 'BLOCK')) {
    const reviewComment = findLatestFreshReviewComment(pr)
    if (!reviewComment) {
      return {
        action: 'review',
        transition: 'PR -> CR',
        reviewer: pr.reviewer ?? undefined,
        explanation: 'downgraded from Fix: no usable review comment for current head SHA',
      }
    }
    return {
      action: 'fix',
      transition: `${latest.verdict === 'BLOCK' ? 'BLOCK' : 'NEEDS_WORK'} -> Fix`,
      fixer: pr.origin === 'claude' || pr.origin === 'codex' ? pr.origin : 'auto',
      delivery: config.post_review.auto_fix.delivery.mode,
      reviewComment,
    }
  }

  if (latest.sha !== undefined && latest.sha !== pr.headSha) {
    return {
      action: 'review',
      transition: 'PR -> CR',
      reviewer: pr.reviewer ?? undefined,
      explanation: `downgraded from ${latest.verdict ?? latest.type ?? 'prior state'}: latest crosscheck annotation is for old head SHA ${shortSha(latest.sha)}`,
    }
  }

  if (latest.type === 'recheck' && (latest.verdict === 'NEEDS_WORK' || latest.verdict === 'BLOCK')) {
    return {
      action: 'recheck',
      transition: 'RECHECK -> Recheck',
      reviewer: pr.reviewer ?? undefined,
      reviewComment: findLatestFreshReviewComment(pr) ?? undefined,
    }
  }

  if ((latest.type === 'review' || latest.type === 'recheck') && latest.verdict === 'APPROVE') {
    return {
      action: 'merge',
      transition: 'APPROVE -> Merge',
      mergeMethod: 'squash',
      checks: 'green',
    }
  }

  return {
    action: 'review',
    transition: 'PR -> CR',
    reviewer: pr.reviewer ?? undefined,
  }
}

export function buildKickassPlan(prs: KickassScannedPR[], config: Config): KickassPlanItem[] {
  return prs.map(pr => ({
    key: `${pr.owner}/${pr.repo}#${pr.number}`,
    pr,
    scannedHeadSha: pr.headSha,
    ...actionForPR(pr, config),
  }))
}

function pickerItems(items: KickassPlanItem[]): PRPickerItem[] {
  return items.map(item => ({
    key: item.key,
    label: `${prLabel(item.pr)}@${shortSha(item.scannedHeadSha)}`,
    action: item.action,
    description: item.explanation ?? item.transition,
  }))
}

function groupPreflight(items: KickassPlanItem[]): Map<string, KickassPlanItem[]> {
  const groups = new Map<string, KickassPlanItem[]>()
  for (const item of items) {
    const existing = groups.get(item.transition) ?? []
    existing.push(item)
    groups.set(item.transition, existing)
  }
  return groups
}

export function formatPreflightSummary(items: KickassPlanItem[]): string {
  if (items.length === 0) return 'No PRs selected.'

  const lines: string[] = []
  for (const [transition, group] of groupPreflight(items)) {
    lines.push(transition)
    for (const item of group) {
      const parts = [`  ${prLabel(item.pr)}@${shortSha(item.scannedHeadSha)}`]
      if (item.reviewer) parts.push(`reviewer ${item.reviewer}`)
      if (item.fixer) parts.push(`fixer ${item.fixer}`)
      if (item.delivery) parts.push(`delivery ${item.delivery}`)
      if (item.mergeMethod) parts.push(`method ${item.mergeMethod}`)
      if (item.checks) parts.push(`checks ${item.checks}`)
      if (item.explanation) parts.push(chalk.dim(item.explanation))
      lines.push(parts.join('  '))
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

async function defaultConfirm(items: KickassPlanItem[]): Promise<boolean> {
  if (!process.stdin.isTTY || items.length === 0) return false
  process.stdout.write(`\nProceed with ${items.length} mutation${items.length === 1 ? '' : 's'}? [y/N] `)
  return new Promise<boolean>((resolve) => {
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    process.stdin.once('data', (data: string) => {
      process.stdin.pause()
      resolve(data.trim().toLowerCase() === 'y' || data.trim().toLowerCase() === 'yes')
    })
  })
}

async function expandScopes(scopes: BacktraceScope[], token: string): Promise<Array<{ owner: string; repo: string }>> {
  const nested = await Promise.all(scopes.map(async (scope) => {
    if ('org' in scope) {
      try {
        const repos = await listOrgRepos(scope.org, token)
        return repos.map(repo => ({ owner: repo.owner, repo: repo.name }))
      } catch {
        return []
      }
    }
    return [{ owner: scope.owner, repo: scope.repo }]
  }))
  return nested.flat()
}

export async function scanKickassPRs(config: Config, token: string, force: boolean): Promise<KickassScanResult> {
  const now = Date.now()
  if (!force && scanCache && now - scanCache.writtenAt < SCAN_CACHE_MS) {
    return scanCache.result
  }

  const scopes = await buildScopesFromConfig(config, token)
  const repos = await expandScopes(scopes, token)
  const perRepo = await Promise.all(repos.map(async ({ owner, repo }) => {
    try {
      const prs = await listOpenPRs(owner, repo, token)
      return prs.map(pr => ({ owner, repo, pr }))
    } catch {
      return []
    }
  }))

  const scanned = await Promise.all(perRepo.flat().map(async ({ owner, repo, pr }) => {
    if (!isAuthorAllowed(config.routing.allowed_authors, pr.author)) return null
    let comments: PRComment[] = []
    try {
      comments = await listPRComments(owner, repo, pr.number, token)
    } catch {
      return null
    }
    const { origin } = await detectOriginFull(
      pr.body ?? '',
      pr.headRef,
      owner,
      repo,
      pr.number,
      config,
      token,
      pr.author,
    )
    const reviewer = await assignReviewer(origin, config)
    return {
      owner,
      repo,
      number: pr.number,
      title: pr.title,
      author: pr.author,
      headSha: pr.headSha,
      headRef: pr.headRef,
      headRepo: pr.headRepo,
      baseRef: pr.baseRef,
      body: pr.body,
      createdAt: pr.createdAt,
      comments,
      origin,
      reviewer,
    } satisfies KickassScannedPR
  }))

  const result: KickassScanResult = { candidates: scanned.filter(pr => pr !== null) }
  scanCache = { writtenAt: now, result }
  return result
}

export async function executeKickassPlan(
  items: KickassPlanItem[],
  deps: Required<Pick<KickassDeps, 'getCurrentHead' | 'run' | 'merge'>>,
): Promise<KickassExecutionResult> {
  const result: KickassExecutionResult = { executed: 0, skipped: [] }

  await items.reduce<Promise<void>>(async (previous, item) => {
    await previous
    const current = await deps.getCurrentHead(item)
    if (current.sha !== item.scannedHeadSha) {
      result.skipped.push({ pr: prLabel(item.pr), reason: 'stale_signature' })
      return
    }
    if ((item.action === 'fix' || item.action === 'merge') && isForkPR({ ...item.pr, headRepo: current.headRepo })) {
      result.skipped.push({ pr: prLabel(item.pr), reason: 'fork_pr' })
      return
    }

    if (item.action === 'merge') {
      await deps.merge(item)
    } else {
      await deps.run(item, item.action)
    }
    result.executed++
  }, Promise.resolve())

  return result
}

function defaultRun(item: KickassPlanItem, steps: string): Promise<void> {
  const opts: RunOpts = { steps, expectedHeadSha: item.scannedHeadSha }
  if ((item.action === 'fix' || item.action === 'recheck') && item.reviewComment) {
    opts.initialReviewComment = item.reviewComment
  }
  return runRun(prUrl(item.pr), opts)
}

async function defaultMerge(item: KickassPlanItem, token: string): Promise<void> {
  const octokit = createGithubClient(token)
  await mergePullRequest(octokit, {
    owner: item.pr.owner,
    repo: item.pr.repo,
    pullNumber: item.pr.number,
    method: item.mergeMethod === 'merge' || item.mergeMethod === 'rebase' ? item.mergeMethod : 'squash',
    expectedHeadSha: item.scannedHeadSha,
  })
}

function defaultGetCurrentHead(token: string): (item: KickassPlanItem) => Promise<{ sha: string; headRepo: string | null }> {
  return async (item) => {
    const octokit = createGithubClient(token)
    const { data } = await octokit.rest.pulls.get({
      owner: item.pr.owner,
      repo: item.pr.repo,
      pull_number: item.pr.number,
    })
    return {
      sha: data.head.sha,
      headRepo: data.head.repo?.full_name ?? null,
    }
  }
}

export async function runKickass(opts: KickassOpts = {}, deps: KickassDeps = {}): Promise<KickassExecutionResult> {
  const log = deps.log ?? ((line: string) => console.log(line))
  const config = deps.config ?? loadConfig(opts.config)
  initLogger(config.logs)
  fileLog({ level: 'info', event: 'session_start', command: 'kickass' })

  let token = deps.token ?? ''
  if (!deps.token) {
    try {
      token = getGithubToken()
    } catch (err) {
      logError({ command: 'kickass', phase: 'auth' }, err)
      console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
      process.exit(1)
    }
  }

  const scan = deps.scan ?? ((force: boolean) => scanKickassPRs(config, token, force))
  const scanResult = await scan(opts.force === true)
  const plan = buildKickassPlan(scanResult.candidates, config)

  if (plan.length === 0) {
    log(chalk.dim('No actionable PRs found.'))
    return { executed: 0, skipped: [] }
  }

  const picker = deps.pick ?? (async (items: KickassPlanItem[]) => {
    const selectedKeys = await promptPRPicker(pickerItems(items))
    const selected = new Set(selectedKeys)
    return items.filter(item => selected.has(item.key))
  })
  const selected = await picker(plan)
  log(formatPreflightSummary(selected))

  if (selected.length === 0) return { executed: 0, skipped: [] }
  if (opts.dryRun) {
    return {
      executed: 0,
      skipped: selected.map(item => ({ pr: prLabel(item.pr), reason: 'dry_run' })),
    }
  }

  const confirm = deps.confirm ?? defaultConfirm
  if (!await confirm(selected)) {
    log(chalk.dim('Cancelled. No mutations performed.'))
    return { executed: 0, skipped: selected.map(item => ({ pr: prLabel(item.pr), reason: 'cancelled' })) }
  }

  try {
    return await executeKickassPlan(selected, {
      getCurrentHead: deps.getCurrentHead ?? defaultGetCurrentHead(token),
      run: deps.run ?? defaultRun,
      merge: deps.merge ?? ((item: KickassPlanItem) => defaultMerge(item, token)),
    })
  } catch (err) {
    logError({ command: 'kickass', phase: 'execute' }, err)
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
    process.exit(2)
  }
}
