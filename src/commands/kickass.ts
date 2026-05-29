import chalk from 'chalk'
import { parseDuration } from '../lib/durations.js'
import { pickPRs } from '../lib/pr-picker.js'
import type { PRStatus } from '../lib/pr-status.js'
import { runRun } from './run.js'
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
    const steps = stepsForPR(pr)
    const stepArg = steps ? ` --steps ${steps}` : ''
    console.log(`  crosscheck run ${pr.url}${stepArg} --dry-run  ${chalk.dim(`#${pr.number} ${pr.reviewState}`)}`)
  }
}

function runSelected(prs: PRStatus[]): Promise<void> {
  return prs.reduce<Promise<void>>(async (previous, pr) => {
    await previous
    const steps = stepsForPR(pr)
    console.log(chalk.cyan(`\n→ advancing #${pr.number} ${pr.owner}/${pr.repo} (${pr.reviewState})`))
    await runRun(pr.url, { ...(steps && { steps }) })
  }, Promise.resolve())
}

function stepsForPR(pr: PRStatus): string | undefined {
  if (pr.nextAction === 'review') return 'review'
  if (pr.nextAction === 'recheck') return 'recheck'
  return undefined
}
