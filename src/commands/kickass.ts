import chalk from 'chalk'
import { existsSync } from 'fs'
import { stdin as input, stdout as output } from 'process'
import { createInterface } from 'readline/promises'
import { fileURLToPath } from 'url'
import { execa } from 'execa'
import { createGithubClient } from '../github/client.js'
import { getGithubToken, loadConfig } from '../config/loader.js'
import type { Config } from '../config/schema.js'
import { parseDuration } from '../lib/durations.js'
import { logError } from '../lib/logger.js'
import { pickPRs } from '../lib/pr-picker.js'
import type { ScanPRStatus as PRStatus, ScanResult } from '../lib/pr-status.js'
import { handleScanError, loadScanResult } from './scan.js'

export interface KickassOpts {
  force?: boolean
  staleAfter?: string
  dryRun?: boolean
  roundMode?: 'crazy' | 'halfcrazy'
  timeout?: string
}

export type KickassAction = 'review' | 'fix' | 'recheck' | 'skip'
export type KickassSkipReason = 'fork_pr' | 'stale_signature'
export type KickassFailureReason = 'error'
export type FixDeliveryMode = Config['post_review']['auto_fix']['delivery']['mode']

export interface PreflightItem {
  pr: PRStatus
  action: KickassAction
  transition: string
  details: string[]
  explanation?: string
  skipReason?: KickassSkipReason
  chainRecheck?: boolean
}

export interface KickassExecutionResult {
  pr: PRStatus
  status: 'executed' | 'skipped' | 'failed'
  reason?: KickassSkipReason | KickassFailureReason
}

export interface ExecuteKickassDeps {
  getCurrentHeadSha: (item: PreflightItem) => Promise<string>
  dispatchRun: (item: PreflightItem) => Promise<void>
}

export interface KickassDeps {
  loadScanResult: (options: { force?: boolean; staleAfterMs: number }) => Promise<ScanResult>
  pickPRs: (prs: PRStatus[]) => Promise<PRStatus[]>
  confirm: (message: string) => Promise<boolean>
  getFixDeliveryMode?: () => FixDeliveryMode | Promise<FixDeliveryMode>
  getCurrentHeadSha: (item: PreflightItem) => Promise<string>
  dispatchRun: (item: PreflightItem) => Promise<void>
}

export async function runKickass(opts: KickassOpts = {}): Promise<void> {
  await runKickassWithDeps(opts, defaultKickassDeps(opts))
}

export async function runKickassWithDeps(
  opts: KickassOpts = {},
  deps: KickassDeps,
): Promise<void> {
  let staleAfterMs: number
  try {
    staleAfterMs = parseDuration(opts.staleAfter ?? '24h')
  } catch (err: unknown) {
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }

  if (opts.timeout) {
    try {
      parseDuration(opts.timeout)
    } catch {
      console.error(chalk.red(`✗ Invalid --timeout value "${opts.timeout}". Use a duration like 300s or 10m.`))
      process.exit(1)
    }
  }

  try {
    const scan = await deps.loadScanResult({ force: opts.force, staleAfterMs })

    // Actionable = nextAction is set and is not merge (merge not dispatched in v1).
    // Stale PRs shown first; not-stale actionable PRs follow.
    const queue = scan.prs
      .filter(pr => pr.nextAction !== null && pr.nextAction !== 'merge')
      .sort((a, b) => {
        if (a.freshness !== b.freshness) return a.freshness === 'stale' ? -1 : 1
        return 0
      })

    const mergeReady = scan.prs.filter(pr => pr.nextAction === 'merge')

    if (queue.length === 0 && mergeReady.length === 0) {
      console.log(chalk.dim('No actionable PRs found.'))
      return
    }
    if (queue.length === 0) {
      printMergeReady(mergeReady)
      console.log(chalk.dim('\nNo PRs need review, fix, or recheck — all actionable work is merge-ready (manual).'))
      return
    }

    const selected = await deps.pickPRs(queue)
    if (selected.length === 0) {
      console.log(chalk.dim('No PRs selected.'))
      return
    }

    const fixDeliveryMode = deps.getFixDeliveryMode ? await deps.getFixDeliveryMode() : 'pull_request'
    const plan = buildPreflightPlan(selected, opts.roundMode, fixDeliveryMode)
    printPreflight(plan, mergeReady)

    if (opts.dryRun) {
      console.log(chalk.dim('\ndry-run: no mutations executed'))
      return
    }

    const shouldRun = await deps.confirm('Proceed with these mutations?')
    if (!shouldRun) {
      console.log(chalk.dim('Canceled.'))
      return
    }

    const results = await executeKickassPlan(plan, deps)
    printExecutionSummary(results)
    if (results.some(result => result.status === 'failed')) {
      process.exitCode = 2
    }
  } catch (err: unknown) {
    handleScanError('kickass', err)
  }
}

export function buildPreflightPlan(
  prs: PRStatus[],
  roundMode?: 'crazy' | 'halfcrazy',
  fixDeliveryMode: FixDeliveryMode = 'pull_request',
): PreflightItem[] {
  const modeTag = roundMode ? ` [${roundMode}]` : ''
  const chainRecheck = fixDeliveryMode === 'commit'
  return prs.map((pr) => {
    const fork = isForkPR(pr)
    if (pr.nextAction === 'fix' && fork) {
      return {
        pr,
        action: 'skip',
        transition: `${pr.reviewState} -> Skip`,
        details: ['reason fork_pr'],
        skipReason: 'fork_pr',
      }
    }

    if (pr.nextAction === 'fix' && !hasUsableCurrentHeadReview(pr)) {
      return {
        pr,
        action: 'review',
        transition: 'PR -> CR',
        details: [`reviewer ${reviewerLabel(pr)}`],
        explanation: 'no_usable_review_comment',
      }
    }

    if (pr.nextAction === 'review') {
      return {
        pr,
        action: 'review',
        transition: 'PR -> CR',
        details: [`reviewer ${reviewerLabel(pr)}`],
      }
    }

    if (pr.nextAction === 'fix') {
      return {
        pr,
        action: 'fix',
        transition: chainRecheck
          ? `${pr.reviewState} -> fix→recheck${modeTag}`
          : `${pr.reviewState} -> fix`,
        details: [
          `fixer ${fixerLabel(pr)}`,
          `delivery ${fixDeliveryMode}`,
          ...(chainRecheck ? [] : ['recheck deferred']),
        ],
        chainRecheck,
      }
    }

    // nextAction === 'recheck' — fix was applied externally; close the loop with one recheck
    return {
      pr,
      action: 'recheck',
      transition: `${pr.reviewState} -> Recheck`,
      details: ['links latest review'],
    }
  })
}

export async function executeKickassPlan(
  plan: PreflightItem[],
  deps: ExecuteKickassDeps,
): Promise<KickassExecutionResult[]> {
  const results: KickassExecutionResult[] = []

  for (const item of plan) {
    if (item.action === 'skip') {
      console.log(chalk.yellow(`↷ skip ${formatPRSignature(item.pr)}  ${item.skipReason ?? 'skipped'}`))
      results.push({ pr: item.pr, status: 'skipped', reason: item.skipReason })
      continue
    }

    try {
      const currentHeadSha = await deps.getCurrentHeadSha(item)
      if (currentHeadSha !== item.pr.headSha) {
        console.log(chalk.yellow(`↷ skip ${formatPRSignature(item.pr)}  stale_signature`))
        results.push({ pr: item.pr, status: 'skipped', reason: 'stale_signature' })
        continue
      }

      console.log(chalk.cyan(`\n→ ${item.transition}  ${formatPRSignature(item.pr)}`))
      await deps.dispatchRun(item)
      if (item.action === 'fix' && item.chainRecheck === true) {
        const fixedHeadSha = await deps.getCurrentHeadSha(item)
        if (fixedHeadSha !== item.pr.headSha) {
          const recheckItem = buildPostFixRecheckItem(item, fixedHeadSha)
          console.log(chalk.cyan(`\n→ ${recheckItem.transition}  ${formatPRSignature(recheckItem.pr)}`))
          await deps.dispatchRun(recheckItem)
        } else {
          console.log(chalk.dim(`  head SHA unchanged after fix — recheck deferred`))
        }
      }
      results.push({ pr: item.pr, status: 'executed' })
    } catch (err: unknown) {
      logError({ event: 'kickass_pr_failed', owner: item.pr.owner, repo: item.pr.repo, pr: item.pr.number }, err)
      console.error(chalk.red(`✗ failed ${formatPRSignature(item.pr)}`))
      results.push({ pr: item.pr, status: 'failed', reason: 'error' })
    }
  }

  return results
}

function buildPostFixRecheckItem(item: PreflightItem, headSha: string): PreflightItem {
  return {
    pr: { ...item.pr, headSha, nextAction: 'recheck', reviewState: 'NEEDS_RECHECK' },
    action: 'recheck',
    transition: 'fix -> Recheck',
    details: ['links latest review', `head ${headSha.slice(0, 7)}`],
  }
}

export function printPreflight(plan: PreflightItem[], mergeReady: PRStatus[] = []): void {
  console.log('\nPreflight')
  const grouped = groupPreflight(plan)
  for (const [transition, items] of grouped) {
    console.log(`\n${transition}`)
    for (const item of items) {
      const explanation = item.explanation ? `  ${chalk.dim(item.explanation)}` : ''
      console.log(`  ${formatPRSignature(item.pr)}  ${item.details.join('  ')}${explanation}`)
    }
  }
  if (mergeReady.length > 0) printMergeReady(mergeReady)
}

export function printMergeReady(prs: PRStatus[]): void {
  console.log(chalk.dim('\nneeds merge (manual — not selected)'))
  for (const pr of prs) {
    console.log(chalk.dim(`  ${formatPRSignature(pr)}  APPROVE`))
  }
}

export function summarizeExecutionResults(results: KickassExecutionResult[]): string {
  const executed = results.filter(result => result.status === 'executed').length
  const skipped = results.filter(result => result.status === 'skipped').length
  const failed = results.filter(result => result.status === 'failed').length
  return `Execution summary: ${executed} executed, ${skipped} skipped, ${failed} failed`
}

export function printExecutionSummary(results: KickassExecutionResult[]): void {
  console.log(chalk.dim(`\n${summarizeExecutionResults(results)}`))
}

export function buildKickassRunArgs(
  itemOrPR: PreflightItem | PRStatus,
  roundMode?: 'crazy' | 'halfcrazy',
  timeout?: string,
): string[] {
  const item = 'action' in itemOrPR ? itemOrPR : buildPreflightPlan([itemOrPR])[0]
  if (item.action === 'skip') return []
  const args = [
    'run',
    item.pr.url,
    '--steps',
    stepsForItem(item),
    '--expected-head-sha',
    item.pr.headSha,
  ]
  if (item.action !== 'fix') {
    if (roundMode === 'crazy') args.push('--crazy')
    else if (roundMode === 'halfcrazy') args.push('--halfcrazy')
  }
  // crazy/halfcrazy lift all timeout constraints; don't forward --timeout in those modes
  if (timeout && !roundMode) args.push('--timeout', timeout)
  return args
}

export interface CliInvocation {
  command: string
  args: string[]
}

interface ResolveCliInvocationOptions {
  argvEntry?: string
  execPath?: string
  exists?: (path: string) => boolean
  urlToPath?: (url: URL) => string
}

export function resolveCliInvocation(options: ResolveCliInvocationOptions = {}): CliInvocation {
  const exists = options.exists ?? existsSync
  const urlToPath = options.urlToPath ?? fileURLToPath
  const execPath = options.execPath ?? process.execPath
  const argvEntry = options.argvEntry ?? process.argv[1]
  const localTsx = urlToPath(new URL('../../node_modules/.bin/tsx', import.meta.url))

  if (argvEntry && exists(argvEntry)) {
    return invocationForEntry(argvEntry, execPath, localTsx, exists)
  }

  const builtCli = urlToPath(new URL('../cli.js', import.meta.url))
  if (exists(builtCli)) return { command: execPath, args: [builtCli] }

  const sourceCli = urlToPath(new URL('../cli.ts', import.meta.url))
  if (exists(sourceCli)) return invocationForEntry(sourceCli, execPath, localTsx, exists)

  throw new Error('Cannot resolve crosscheck CLI entrypoint. Run npm run build before kickass, or run from a source checkout with dev dependencies installed.')
}

function defaultKickassDeps(opts: KickassOpts = {}): KickassDeps {
  let cli: CliInvocation | undefined
  const getCli = (): CliInvocation => {
    cli ??= resolveCliInvocation()
    return cli
  }
  return {
    loadScanResult,
    pickPRs,
    confirm: confirmMutation,
    getFixDeliveryMode: () => loadConfig().post_review.auto_fix.delivery.mode,
    getCurrentHeadSha: async (item) => {
      const token = getGithubToken()
      const octokit = createGithubClient(token)
      const { data } = await octokit.rest.pulls.get({
        owner: item.pr.owner,
        repo: item.pr.repo,
        pull_number: item.pr.number,
      })
      return data.head.sha
    },
    dispatchRun: async (item) => {
      const invocation = getCli()
      await execa(invocation.command, [...invocation.args, ...buildKickassRunArgs(item, opts.roundMode, opts.timeout)], { stdio: 'inherit' })
    },
  }
}

async function confirmMutation(message: string): Promise<boolean> {
  const rl = createInterface({ input, output })
  try {
    const answer = await rl.question(`${message} [y/N] `)
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes'
  } finally {
    rl.close()
  }
}

function groupPreflight(plan: PreflightItem[]): Array<[string, PreflightItem[]]> {
  const groups = new Map<string, PreflightItem[]>()
  for (const item of plan) {
    const current = groups.get(item.transition) ?? []
    current.push(item)
    groups.set(item.transition, current)
  }
  return [...groups.entries()]
}

function hasUsableCurrentHeadReview(pr: PRStatus): boolean {
  const annotation = pr.latestAnnotation
  if (!annotation || annotation.type !== 'review' || !annotation.sha) return false
  return pr.headSha.startsWith(annotation.sha) || annotation.sha.startsWith(pr.headSha)
}

function isForkPR(pr: PRStatus): boolean {
  return pr.headRepo !== undefined
    && pr.headRepo !== null
    && pr.headRepo.toLowerCase() !== `${pr.owner}/${pr.repo}`.toLowerCase()
}

function reviewerLabel(pr: PRStatus): string {
  return pr.latestAnnotation?.reviewer ?? 'auto'
}

function fixerLabel(pr: PRStatus): string {
  return pr.latestAnnotation?.origin ?? 'origin'
}

function checksLabel(pr: PRStatus): string {
  if (!pr.merge) return 'unknown'
  if (pr.merge.mergeStateStatus === 'clean' || pr.merge.mergeStateStatus === 'has_hooks') return 'green'
  return pr.merge.mergeStateStatus ?? 'unknown'
}

function stepsForItem(item: PreflightItem): string {
  if (item.action === 'review') return 'review'
  if (item.action === 'fix') return 'fix'
  return 'recheck'
}

function formatPRSignature(pr: PRStatus): string {
  return `${pr.owner}/${pr.repo}#${pr.number}@${pr.headSha.slice(0, 7)}`
}

function invocationForEntry(
  entry: string,
  execPath: string,
  localTsx: string,
  exists: (path: string) => boolean,
): CliInvocation {
  if (!entry.endsWith('.ts')) return { command: execPath, args: [entry] }
  if (exists(localTsx)) return { command: localTsx, args: [entry] }
  throw new Error('Cannot run kickass actions from a TypeScript entrypoint without the local tsx dev dependency. Run npm run build first.')
}
