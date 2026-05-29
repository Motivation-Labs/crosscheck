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
  const failures = await prs.reduce<Promise<PRStatus[]>>(async (previous, pr) => {
    const failed = await previous
    console.log(chalk.cyan(`\n→ advancing #${pr.number} ${pr.owner}/${pr.repo} (${pr.reviewState})`))
    try {
      await execa(process.execPath, [resolveCliEntry(), ...buildKickassRunArgs(pr, false)], { stdio: 'inherit' })
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

function resolveCliEntry(): string {
  const cliFromArgv = process.argv[1]
  if (cliFromArgv && cliFromArgv.endsWith('cli.js')) return cliFromArgv

  const builtCli = fileURLToPath(new URL('../cli.js', import.meta.url))
  if (existsSync(builtCli)) return builtCli
  return fileURLToPath(new URL('../cli.ts', import.meta.url))
}
