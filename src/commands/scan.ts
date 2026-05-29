import chalk from 'chalk'
import { getGithubToken, loadConfig } from '../config/loader.js'
import { formatDuration, parseDuration } from '../lib/durations.js'
import { initLogger, logError } from '../lib/logger.js'
import { scanOpenPRStatuses, type PRStatus, type ScanResult } from '../lib/pr-status.js'
import { readScanCache, writeScanCache, type ScanCachePayload } from '../lib/scan-cache.js'

export interface ScanOpts {
  tidy?: boolean
  force?: boolean
  staleAfter?: string
  json?: boolean
}

interface LoadScanOptions {
  force?: boolean
  staleAfterMs: number
}

export async function loadScanResult(options: LoadScanOptions): Promise<ScanResult> {
  const config = loadConfig()
  initLogger(config.logs)
  const token = getGithubToken()
  const now = new Date()

  if (!options.force) {
    const cached = readScanCache({
      nowMs: now.getTime(),
      staleAfterMs: options.staleAfterMs,
    })
    if (cached) return { ...cached, cached: true }
  }

  const result = await scanOpenPRStatuses(config, token, {
    now,
    staleAfterMs: options.staleAfterMs,
  })
  writeScanCache(toCachePayload(result))
  return result
}

export async function runScan(opts: ScanOpts = {}): Promise<void> {
  let staleAfterMs: number
  try {
    staleAfterMs = parseDuration(opts.staleAfter ?? '24h')
  } catch (err: unknown) {
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }

  try {
    const result = await loadScanResult({ force: opts.force, staleAfterMs })
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }
    printScanResult(result, opts.tidy === true)
  } catch (err: unknown) {
    handleScanError('scan', err)
  }
}

export function printScanResult(result: ScanResult, tidy: boolean): void {
  const visible = tidy
    ? result.prs.filter(pr => pr.freshness === 'stale' && pr.nextAction !== null)
    : result.prs

  const cacheNote = result.cached ? chalk.dim(' cached') : ''
  console.log(`crosscheck scan${cacheNote}`)
  console.log(chalk.dim(`  scanned     ${result.scannedAt}`))
  console.log(chalk.dim(`  stale after ${formatDuration(result.staleAfterMs)}`))
  console.log(`  total       ${result.summary.total}`)
  console.log(`  stale       ${chalk.yellow(result.summary.stale)}`)
  console.log(`  actionable  ${chalk.cyan(result.summary.actionable)}`)
  console.log()

  if (visible.length === 0) {
    console.log(tidy ? chalk.dim('No stale PRs need attention.') : chalk.dim('No open PRs found in the configured monitor scope.'))
    return
  }

  for (const pr of visible) {
    console.log(formatPRLine(pr))
  }
}

function formatPRLine(pr: PRStatus): string {
  const freshness = pr.freshness === 'stale' ? chalk.yellow('stale') : chalk.dim('not_stale')
  const next = pr.nextAction ? `next=${pr.nextAction}` : 'terminal'
  const age = formatAge(pr.ageMs)
  return [
    `  ${freshness}`,
    chalk.cyan(`#${pr.number}`),
    `${pr.owner}/${pr.repo}`,
    chalk.bold(pr.reviewState),
    chalk.dim(`last=${age}`),
    chalk.dim(next),
    pr.title,
  ].join('  ')
}

function formatAge(ms: number): string {
  const minuteMs = 60 * 1000
  const hourMs = 60 * minuteMs
  const dayMs = 24 * hourMs
  if (ms >= dayMs) return `${Math.floor(ms / dayMs)}d`
  if (ms >= hourMs) return `${Math.floor(ms / hourMs)}h`
  return `${Math.floor(ms / minuteMs)}m`
}

function toCachePayload(result: ScanResult): ScanCachePayload {
  return {
    scannedAt: result.scannedAt,
    staleAfterMs: result.staleAfterMs,
    summary: result.summary,
    prs: result.prs,
  }
}

export function handleScanError(command: string, err: unknown): never {
  logError({ command }, err)
  const message = err instanceof Error ? err.message : String(err)
  console.error(chalk.red(`✗ ${message}`))
  process.exit(isUserError(message) ? 1 : 2)
}

function isUserError(message: string): boolean {
  return message.startsWith('No GitHub token found') || message.includes('Invalid configuration')
}
