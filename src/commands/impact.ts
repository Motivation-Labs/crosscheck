import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import chalk from 'chalk'
import { loadConfig } from '../config/loader.js'
import type { ImpactConfig } from '../config/schema.js'
import { getLogDir } from '../lib/logger.js'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

interface LogLine {
  ts: string
  level: string
  event: string
  pr?: number
  repo?: string
  reviewer?: string
  verdict?: string
  duration_ms?: number
}

export interface WeeklyBucket {
  week: string
  reviews: number
  blocks: number
  rate: number
}

export interface ImpactReport {
  period: { from: string; to: string; log_files: number }
  reviews_total: number
  reviews_without_verdict: number
  issues_caught: number
  total_hours_saved: number
  total_duration_ms: number
  verdict_distribution: { APPROVE: number; NEEDS_WORK: number; BLOCK: number }
  block_rate_by_week: WeeklyBucket[]
  by_reviewer: Record<string, { reviews: number; issues: number }>
  by_repo: Record<string, number>
}

function readLogFiles(sinceDate?: string): { files: string[]; lines: LogLine[] } {
  const logDir = getLogDir()
  if (!existsSync(logDir)) return { files: [], lines: [] }
  const files = readdirSync(logDir)
    .filter(f => f.endsWith('.ndjson'))
    .sort()
    .filter(f => !sinceDate || f.replace('.ndjson', '') >= sinceDate)
    .map(f => join(logDir, f))
  const lines: LogLine[] = []
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { lines.push(JSON.parse(line) as LogLine) } catch { /* skip malformed */ }
    }
  }
  return { files, lines }
}

function normalizeVerdict(v: string | undefined): 'APPROVE' | 'NEEDS_WORK' | 'BLOCK' | null {
  if (!v) return null
  const upper = v.toUpperCase().trim()
  if (upper === 'APPROVE') return 'APPROVE'
  if (upper === 'NEEDS WORK' || upper === 'NEEDS_WORK') return 'NEEDS_WORK'
  if (upper === 'BLOCK') return 'BLOCK'
  return null
}

function getMondayDate(ts: string): string {
  const d = new Date(ts)
  if (isNaN(d.getTime())) return 'unknown'
  const day = d.getUTCDay()
  const diff = day === 0 ? -6 : 1 - day
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff))
  return monday.toISOString().slice(0, 10)
}

function formatWeekLabel(mondayDate: string): string {
  const d = new Date(mondayDate + 'T00:00:00Z')
  if (isNaN(d.getTime())) return mondayDate
  return `${MONTHS[d.getUTCMonth()]} W${Math.ceil(d.getUTCDate() / 7)}`
}

export function buildImpactReport(config: ImpactConfig, sinceDate?: string): ImpactReport {
  const { files, lines } = readLogFiles(sinceDate)
  const reviews = lines.filter(l => l.event === 'review_complete')

  const verdicts = { APPROVE: 0, NEEDS_WORK: 0, BLOCK: 0 }
  const weeklyMap = new Map<string, { reviews: number; blocks: number }>()
  const report: ImpactReport = {
    period: {
      from: files[0]?.split('/').at(-1)?.replace('.ndjson', '') ?? 'N/A',
      to: files.at(-1)?.split('/').at(-1)?.replace('.ndjson', '') ?? 'N/A',
      log_files: files.length,
    },
    reviews_total: reviews.length,
    reviews_without_verdict: 0,
    issues_caught: 0,
    total_hours_saved: 0,
    total_duration_ms: 0,
    verdict_distribution: verdicts,
    block_rate_by_week: [],
    by_reviewer: {},
    by_repo: {},
  }

  for (const r of reviews) {
    const durationMs = r.duration_ms ?? 2 * 60 * 1000
    report.total_hours_saved += Math.max(0, config.assumed_human_review_minutes - durationMs / 60_000) / 60
    report.total_duration_ms += durationMs

    const v = normalizeVerdict(r.verdict)
    if (!v) {
      report.reviews_without_verdict++
    } else {
      verdicts[v]++
      if (v === 'NEEDS_WORK' || v === 'BLOCK') report.issues_caught++
    }

    // Weekly BLOCK rate: denominator is verdict-bearing reviews only, so verdictless
    // reviews (from `crosscheck review`) don't artificially depress the rate.
    if (v && r.ts) {
      const week = getMondayDate(r.ts)
      const bucket = weeklyMap.get(week) ?? { reviews: 0, blocks: 0 }
      bucket.reviews++
      if (v === 'BLOCK') bucket.blocks++
      weeklyMap.set(week, bucket)
    }

    if (r.reviewer) {
      if (!report.by_reviewer[r.reviewer]) report.by_reviewer[r.reviewer] = { reviews: 0, issues: 0 }
      report.by_reviewer[r.reviewer].reviews++
      if (v === 'NEEDS_WORK' || v === 'BLOCK') report.by_reviewer[r.reviewer].issues++
    }

    if (r.repo) report.by_repo[r.repo] = (report.by_repo[r.repo] ?? 0) + 1
  }

  report.block_rate_by_week = [...weeklyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, { reviews, blocks }]) => ({ week, reviews, blocks, rate: reviews > 0 ? blocks / reviews : 0 }))

  return report
}

function renderBar(value: number, max: number, width = 16): string {
  if (max === 0 || value === 0) return ''
  return '█'.repeat(Math.max(1, Math.round((value / max) * width)))
}

function pct(n: number, total: number): string {
  return total === 0 ? '—' : `(${Math.round((n / total) * 100)}%)`
}

function formatReport(report: ImpactReport, config: ImpactConfig, showMoney: boolean, retentionDays: number): void {
  if (report.reviews_total === 0) {
    console.log(chalk.yellow('\nNo review data yet — run crosscheck watch to start collecting.\n'))
    return
  }

  const sep = chalk.dim('─'.repeat(50))
  const periodLabel = report.period.from === 'N/A'
    ? 'no data'
    : `${report.period.from} → ${report.period.to}`
  console.log(chalk.bold(`\ncrosscheck impact`) + chalk.dim(`  (${periodLabel} · ${report.reviews_total} reviews)\n`))
  if (report.reviews_without_verdict > 0) {
    console.log(`  ${chalk.dim(`ⓘ ${report.reviews_without_verdict} review${report.reviews_without_verdict === 1 ? '' : 's'} have no verdict (run via \`crosscheck review\`) — excluded from BLOCK rate trend`)}`)
    console.log()
  }

  // Time saved
  console.log(chalk.dim('  Time saved'))
  console.log(`  ${sep}`)
  const avgAiMin = report.reviews_total > 0 ? (report.total_duration_ms / report.reviews_total) / 60_000 : 2
  const savedPerReview = config.assumed_human_review_minutes - avgAiMin
  console.log(`  ${'Reviews run'.padEnd(26)} ${report.reviews_total}`)
  console.log(`  ${'Avg AI review time'.padEnd(26)} ~${Math.round(avgAiMin * 10) / 10} min`)
  console.log(`  ${'Assumed human time'.padEnd(26)} ${config.assumed_human_review_minutes} min  ${chalk.dim('ⓘ')}`)
  console.log(`  ${'Time saved per review'.padEnd(26)} ~${Math.round(savedPerReview * 10) / 10} min`)
  console.log(`  ${'Total time saved'.padEnd(26)} ${chalk.green(`~${Math.round(report.total_hours_saved)} h`)}`)
  console.log()

  // Issues caught
  const { APPROVE, NEEDS_WORK, BLOCK } = report.verdict_distribution
  const verdictTotal = APPROVE + NEEDS_WORK + BLOCK
  console.log(chalk.dim('  Issues caught'))
  console.log(`  ${sep}`)
  console.log(`  ${'APPROVE'.padEnd(18)} ${String(APPROVE).padStart(4)}  ${chalk.dim(pct(APPROVE, verdictTotal))}`)
  console.log(`  ${'NEEDS WORK'.padEnd(18)} ${String(NEEDS_WORK).padStart(4)}  ${chalk.dim(pct(NEEDS_WORK, verdictTotal))}   ${chalk.yellow('← actionable feedback')}`)
  console.log(`  ${'BLOCK'.padEnd(18)} ${String(BLOCK).padStart(4)}  ${chalk.dim(pct(BLOCK, verdictTotal))}   ${chalk.red('← potential bugs / breaking changes')}`)
  console.log(`  ${'Total issues caught'.padEnd(18)} ${chalk.yellow(String(report.issues_caught).padStart(4))}`)
  console.log()

  // Weekly BLOCK rate trend (last 12 weeks)
  const weeks = report.block_rate_by_week.slice(-12)
  if (weeks.length >= 2) {
    console.log(chalk.dim('  Code quality trend  (BLOCK rate, weekly)'))
    console.log(`  ${sep}`)
    const maxRate = Math.max(...weeks.map(w => w.rate), 0.01)
    for (let i = 0; i < weeks.length; i++) {
      const w = weeks[i]
      const bar = renderBar(w.rate, maxRate).padEnd(18)
      const pctStr = `${Math.round(w.rate * 100)}%`.padStart(4)
      let arrow = ''
      if (i === weeks.length - 1) {
        const diff = weeks[weeks.length - 1].rate - weeks[0].rate
        arrow = diff < -0.02 ? chalk.green('  ↓ improving') : diff > 0.02 ? chalk.red('  ↑ worsening') : chalk.dim('  → stable')
      }
      console.log(`  ${formatWeekLabel(w.week).padEnd(8)}  ${chalk.cyan(bar)}  ${pctStr}${arrow}`)
    }
    console.log()
  }

  // Monetary estimate (opt-in)
  if (showMoney) {
    const timeSavingsUSD = report.total_hours_saved * config.hourly_rate_usd
    const issuePreventionUSD = report.issues_caught * config.defect_cost_usd
    const totalUSD = timeSavingsUSD + issuePreventionUSD
    console.log(chalk.dim('  Monetary estimate'))
    console.log(`  ${sep}`)
    console.log(`  ${'Time savings'.padEnd(26)} ~${chalk.green('$' + Math.round(timeSavingsUSD).toLocaleString('en-US'))}  ${chalk.dim(`(${Math.round(report.total_hours_saved)}h × $${config.hourly_rate_usd}/hr)`)}`)
    console.log(`  ${'Issues prevented'.padEnd(26)} ~${chalk.green('$' + Math.round(issuePreventionUSD).toLocaleString('en-US'))}  ${chalk.dim(`(${report.issues_caught} × $${config.defect_cost_usd}/issue)`)}`)
    console.log(`  ${'Total'.padEnd(26)} ~${chalk.bold(chalk.green('$' + Math.round(totalUSD).toLocaleString('en-US')))}`)
    console.log()
    console.log(`  ${chalk.yellow('⚠')} ${chalk.dim('rough estimate · adjust impact.hourly_rate_usd / impact.defect_cost_usd in config · not accounting data')}`)
    console.log()
  } else {
    console.log(chalk.dim(`  ⓘ assumes ${config.assumed_human_review_minutes} min avg human review — set impact.assumed_human_review_minutes to adjust`))
    console.log(chalk.dim('  Run crosscheck impact --money for a rough monetary estimate.'))
    console.log()
  }

  if (report.period.from !== 'N/A') {
    console.log(`  ${chalk.dim(`ⓘ totals cover only the retained log window (${retentionDays}d) — set logs.retention_days in config to extend`)}`)
    console.log()
  }
}

export async function runImpact(opts: { json?: boolean; since?: string; money?: boolean; config?: string }): Promise<void> {
  const config = loadConfig(opts.config)
  const report = buildImpactReport(config.impact, opts.since)

  if (opts.json) {
    console.log(JSON.stringify({ ...report, config: config.impact }, null, 2))
    return
  }

  formatReport(report, config.impact, opts.money ?? false, config.logs.retention_days)
}
