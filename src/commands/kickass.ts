import chalk from 'chalk'
import { existsSync } from 'fs'
import { stdin as input, stdout as output } from 'process'
import { createInterface } from 'readline/promises'
import { fileURLToPath } from 'url'
import { execa } from 'execa'
import { createGithubClient } from '../github/client.js'
import { mergePullRequest } from '../github/merge.js'
import { getGithubToken } from '../config/loader.js'
import { parseDuration } from '../lib/durations.js'
import { logError } from '../lib/logger.js'
import { pickPRs } from '../lib/pr-picker.js'
import type { PRStatus, ScanResult } from '../lib/pr-status.js'
import { handleScanError, loadScanResult } from './scan.js'

export interface KickassOpts {
  force?: boolean
  staleAfter?: string
  dryRun?: boolean
}

export type KickassAction = 'review' | 'fix' | 'recheck' | 'merge' | 'skip'
export type KickassSkipReason = 'fork_pr' | 'stale_signature'

export interface PreflightItem {
  pr: PRStatus
  action: KickassAction
  transition: string
  details: string[]
  explanation?: string
  skipReason?: KickassSkipReason
}

export interface KickassExecutionResult {
  pr: PRStatus
  status: 'executed' | 'skipped' | 'failed'
  reason?: KickassSkipReason
}

export interface ExecuteKickassDeps {
  getCurrentHeadSha: (item: PreflightItem) => Promise<string>
  dispatchRun: (item: PreflightItem) => Promise<void>
  dispatchMerge: (item: PreflightItem) => Promise<void>
}

export interface KickassDeps {
  loadScanResult: (options: { force?: boolean; staleAfterMs: number }) => Promise<ScanResult>
  pickPRs: (prs: PRStatus[]) => Promise<PRStatus[]>
  confirm: (message: string) => Promise<boolean>
  getCurrentHeadSha: (item: PreflightItem) => Promise<string>
  dispatchRun: (item: PreflightItem) => Promise<void>
  dispatchMerge: (item: PreflightItem) => Promise<void>
}

export async function runKickass(opts: KickassOpts = {}): Promise<void> {
  await runKickassWithDeps(opts, defaultKickassDeps())
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

  try {
    const scan = await deps.loadScanResult({ force: opts.force, staleAfterMs })
    const queue = scan.prs.filter(pr => pr.freshness === 'stale' && pr.nextAction !== null)

    if (queue.length === 0) {
      console.log(chalk.dim('No stale PRs need attention.'))
      return
    }

    const selected = await deps.pickPRs(queue)
    if (selected.length === 0) {
      console.log(chalk.dim('No PRs selected.'))
      return
    }

    const plan = buildPreflightPlan(selected)
    printPreflight(plan)

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
    if (results.some(result => result.status === 'failed')) {
      process.exitCode = 2
    }
  } catch (err: unknown) {
    handleScanError('kickass', err)
  }
}

export function buildPreflightPlan(prs: PRStatus[]): PreflightItem[] {
  return prs.map((pr) => {
    const fork = isForkPR(pr)
    if ((pr.nextAction === 'fix' || pr.nextAction === 'merge') && fork) {
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
        transition: `${pr.reviewState} -> Fix`,
        details: [`fixer ${fixerLabel(pr)}`, 'delivery commit'],
      }
    }

    if (pr.nextAction === 'recheck') {
      return {
        pr,
        action: 'recheck',
        transition: `${pr.reviewState} -> Recheck`,
        details: ['links latest review'],
      }
    }

    return {
      pr,
      action: 'merge',
      transition: 'APPROVE -> Merge',
      details: ['method squash', `checks ${checksLabel(pr)}`],
    }
  })
}

export async function executeKickassPlan(
  plan: PreflightItem[],
  deps: ExecuteKickassDeps,
): Promise<KickassExecutionResult[]> {
  return plan.reduce<Promise<KickassExecutionResult[]>>(async (previous, item) => {
    const results = await previous
    if (item.action === 'skip') {
      console.log(chalk.yellow(`↷ skip ${formatPRSignature(item.pr)}  ${item.skipReason ?? 'skipped'}`))
      return [...results, { pr: item.pr, status: 'skipped', reason: item.skipReason }]
    }

    const currentHeadSha = await deps.getCurrentHeadSha(item)
    if (currentHeadSha !== item.pr.headSha) {
      console.log(chalk.yellow(`↷ skip ${formatPRSignature(item.pr)}  stale_signature`))
      return [...results, { pr: item.pr, status: 'skipped', reason: 'stale_signature' }]
    }

    try {
      console.log(chalk.cyan(`\n→ ${item.transition}  ${formatPRSignature(item.pr)}`))
      if (item.action === 'merge') {
        await deps.dispatchMerge(item)
      } else {
        await deps.dispatchRun(item)
      }
      return [...results, { pr: item.pr, status: 'executed' }]
    } catch (err: unknown) {
      logError({ event: 'kickass_pr_failed', owner: item.pr.owner, repo: item.pr.repo, pr: item.pr.number }, err)
      console.error(chalk.red(`✗ failed ${formatPRSignature(item.pr)}`))
      return [...results, { pr: item.pr, status: 'failed' }]
    }
  }, Promise.resolve([]))
}

export function printPreflight(plan: PreflightItem[]): void {
  console.log('\nPreflight')
  const grouped = groupPreflight(plan)
  for (const [transition, items] of grouped) {
    console.log(`\n${transition}`)
    for (const item of items) {
      const explanation = item.explanation ? `  ${chalk.dim(item.explanation)}` : ''
      console.log(`  ${formatPRSignature(item.pr)}  ${item.details.join('  ')}${explanation}`)
    }
  }
}

export function buildKickassRunArgs(itemOrPR: PreflightItem | PRStatus): string[] {
  const item = 'action' in itemOrPR ? itemOrPR : buildPreflightPlan([itemOrPR])[0]
  if (item.action === 'merge' || item.action === 'skip') return []
  return [
    'run',
    item.pr.url,
    '--steps',
    stepForAction(item.action),
  ]
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

function defaultKickassDeps(): KickassDeps {
  let cli: CliInvocation | undefined
  const getCli = (): CliInvocation => {
    cli ??= resolveCliInvocation()
    return cli
  }
  return {
    loadScanResult,
    pickPRs,
    confirm: confirmMutation,
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
      await execa(invocation.command, [...invocation.args, ...buildKickassRunArgs(item)], { stdio: 'inherit' })
    },
    dispatchMerge: async (item) => {
      const token = getGithubToken()
      const octokit = createGithubClient(token)
      await mergePullRequest(octokit, item.pr.owner, item.pr.repo, item.pr.number, {
        method: 'squash',
      })
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

function stepForAction(action: Exclude<KickassAction, 'merge' | 'skip'>): string {
  if (action === 'review') return 'review'
  if (action === 'fix') return 'fix'
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
