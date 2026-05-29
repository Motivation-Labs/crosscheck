import chalk from 'chalk'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { execa } from 'execa'
import { parseDuration } from '../lib/durations.js'
import { logError } from '../lib/logger.js'
import { pickPRs } from '../lib/pr-picker.js'
import type { PRStatus } from '../lib/pr-status.js'
import { handleScanError, loadScanResult } from './scan.js'

export interface KickassOpts {
  force?: boolean
  staleAfter?: string
  dryRun?: boolean
}

export async function runKickass(opts: KickassOpts = {}): Promise<void> {
  let staleAfterMs: number
  try {
    staleAfterMs = parseDuration(opts.staleAfter ?? '24h')
  } catch (err: unknown) {
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }

  try {
    const scan = await loadScanResult({ force: opts.force, staleAfterMs })
    const queue = scan.prs.filter(pr => pr.freshness === 'stale' && pr.nextAction !== null)

    if (queue.length === 0) {
      console.log(chalk.dim('No stale PRs need attention.'))
      return
    }

    if (opts.dryRun) {
      printDryRun(queue)
      return
    }

    const selected = await pickPRs(queue)
    if (selected.length === 0) {
      console.log(chalk.dim('No PRs selected.'))
      return
    }

    await runSelected(selected)
  } catch (err: unknown) {
    handleScanError('kickass', err)
  }
}

function printDryRun(queue: PRStatus[]): void {
  console.log('kickass dry-run')
  for (const pr of queue) {
    console.log(`  crosscheck ${buildKickassRunArgs(pr, true).join(' ')}  ${chalk.dim(`#${pr.number} ${pr.reviewState}`)}`)
  }
}

async function runSelected(prs: PRStatus[]): Promise<void> {
  const cli = resolveCliInvocation()
  const failures = await prs.reduce<Promise<PRStatus[]>>(async (previous, pr) => {
    const failed = await previous
    console.log(chalk.cyan(`\n→ advancing #${pr.number} ${pr.owner}/${pr.repo} (${pr.reviewState})`))
    try {
      await execa(cli.command, [...cli.args, ...buildKickassRunArgs(pr, false)], { stdio: 'inherit' })
      return failed
    } catch (err: unknown) {
      logError({ event: 'kickass_pr_failed', owner: pr.owner, repo: pr.repo, pr: pr.number }, err)
      console.error(chalk.red(`✗ failed to advance #${pr.number} ${pr.owner}/${pr.repo}`))
      return [...failed, pr]
    }
  }, Promise.resolve([]))

  if (failures.length > 0) {
    console.error(chalk.red(`kickass failed for ${failures.length} PR(s); remaining selected PRs were attempted.`))
    process.exitCode = 2
  }
}

export function buildKickassRunArgs(pr: PRStatus, dryRun: boolean): string[] {
  const steps = stepsForPR(pr)
  return [
    'run',
    pr.url,
    ...(steps ? ['--steps', steps] : []),
    ...(dryRun ? ['--dry-run'] : []),
  ]
}

function stepsForPR(pr: PRStatus): string | undefined {
  if (pr.nextAction === 'review') return 'review'
  if (pr.nextAction === 'recheck') return 'recheck'
  return undefined
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
