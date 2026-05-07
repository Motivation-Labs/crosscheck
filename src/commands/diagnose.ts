import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import chalk from 'chalk'

const LOG_DIR = join(homedir(), '.crosscheck', 'logs')

type ErrorPattern = 'command_not_found' | 'base_branch_missing' | 'timeout' | 'auth_failure' | 'other'

interface ErrorEntry {
  pattern: ErrorPattern
  command?: string
  branch?: string
  count: number
  reviewer?: string
}

interface ReviewerPerf {
  attempts: number
  successes: number
  failure_rate: number
}

interface Suggestion {
  type: 'add_constraint' | 'investigate' | 'config_change'
  instruction?: string
  reason: string
}

export interface DiagnoseReport {
  period: { from: string; to: string; log_files: number }
  summary: { total_reviews: number; successful: number; failed: number; failure_rate: number }
  errors: ErrorEntry[]
  verdict_distribution: { APPROVE: number; NEEDS_WORK: number; BLOCK: number }
  repos_seen: string[]
  languages_detected: string[]
  reviewer_performance: Record<string, ReviewerPerf>
  suggestions: Suggestion[]
}

// Maps command names to language identifiers
const COMMAND_LANGUAGE_MAP: Record<string, string[]> = {
  tsc: ['typescript'], 'ts-node': ['typescript'], tsx: ['typescript'],
  npm: ['nodejs'], npx: ['nodejs'], yarn: ['nodejs'], pnpm: ['nodejs'],
  jest: ['nodejs'], vitest: ['nodejs'], mocha: ['nodejs'],
  pytest: ['python'], pip: ['python'], python: ['python'], python3: ['python'],
  cargo: ['rust'],
  go: ['golang'],
  mvn: ['java'], gradle: ['java'],
  rspec: ['ruby'], bundle: ['ruby'],
}

// Language → constraint instruction
const LANGUAGE_CONSTRAINT_MAP: Record<string, string> = {
  typescript: 'Do not run tsc, ts-node, or tsx.',
  nodejs: 'Do not run npm, npx, yarn, or pnpm.',
  jest: 'Do not run jest, vitest, or mocha.',
  python: 'Do not run pytest, pip, or python scripts.',
  rust: 'Do not run cargo build or cargo test.',
  golang: 'Do not run go build or go test.',
  java: 'Do not run mvn or gradle.',
  ruby: 'Do not run bundle exec or rspec.',
}

interface LogEntry {
  ts: string
  level: string
  event: string
  message?: string
  pr?: number
  repo?: string
  reviewer?: string
  verdict?: string
  [key: string]: unknown
}

function parseLogFile(path: string): LogEntry[] {
  const entries: LogEntry[] = []
  const lines = readFileSync(path, 'utf8').split('\n')
  for (const line of lines) {
    if (!line.trim()) continue
    try { entries.push(JSON.parse(line) as LogEntry) } catch { /* skip malformed */ }
  }
  return entries
}

export function classifyError(message: string): { pattern: ErrorPattern; command?: string; branch?: string } {
  const cmdMatch = message.match(/(?:sh:|bash:|zsh:)?\s*([a-zA-Z0-9_-]+):\s*(?:command not found|not found)/i)
  if (cmdMatch) return { pattern: 'command_not_found', command: cmdMatch[1].toLowerCase() }

  const branchMatch = message.match(/fatal: no such branch:?\s*'?([^\s'"]+)'?/i)
  if (branchMatch) return { pattern: 'base_branch_missing', branch: branchMatch[1] }

  if (/timed? ?out|etimedout/i.test(message)) return { pattern: 'timeout' }

  if (/bad credentials|401|unauthorized/i.test(message)) return { pattern: 'auth_failure' }

  return { pattern: 'other' }
}

function detectLanguagesFromCommands(errors: ErrorEntry[]): string[] {
  const detected = new Set<string>()
  for (const e of errors) {
    if (e.pattern === 'command_not_found' && e.command) {
      const langs = COMMAND_LANGUAGE_MAP[e.command] ?? []
      for (const l of langs) detected.add(l)
    }
  }
  return [...detected]
}

function buildSuggestions(errors: ErrorEntry[], languages: string[]): Suggestion[] {
  const suggestions: Suggestion[] = []
  const seen = new Set<string>()

  for (const e of errors) {
    if (e.pattern === 'command_not_found' && e.command) {
      const langs = COMMAND_LANGUAGE_MAP[e.command] ?? []
      for (const lang of langs) {
        const instruction = LANGUAGE_CONSTRAINT_MAP[lang]
        if (instruction && !seen.has(instruction)) {
          seen.add(instruction)
          suggestions.push({
            type: 'add_constraint',
            instruction,
            reason: `${e.command}: command not found ×${e.count}${e.reviewer ? ` (${e.reviewer})` : ''}`,
          })
        }
      }
    }

    if (e.pattern === 'base_branch_missing' && !seen.has('base_branch_missing')) {
      seen.add('base_branch_missing')
      suggestions.push({
        type: 'investigate',
        reason: `base branch '${e.branch}' not found ×${e.count} — verify the branch is fetched before review`,
      })
    }

    if (e.pattern === 'timeout' && e.count >= 2 && !seen.has('timeout')) {
      seen.add('timeout')
      suggestions.push({
        type: 'config_change',
        reason: `review timed out ×${e.count} — consider lowering quality.tier to "fast" or "balanced"`,
      })
    }
  }

  return suggestions
}

function collectLogFiles(since?: string, logDir = LOG_DIR): string[] {
  if (!existsSync(logDir)) return []
  return readdirSync(logDir)
    .filter(f => f.endsWith('.ndjson'))
    .filter(f => !since || f.replace('.ndjson', '') >= since)
    .sort()
    .map(f => join(logDir, f))
}

export function buildDiagnoseReport(since?: string, logDir?: string): DiagnoseReport {
  const files = collectLogFiles(since, logDir)
  const allEntries: LogEntry[] = files.flatMap(parseLogFile)

  // Track review lifecycle: review_started → review_complete
  const started = new Map<string, LogEntry>()     // key: `${repo}#${pr}`
  const completed = new Set<string>()

  const errorPatterns = new Map<string, ErrorEntry>()
  const verdicts = { APPROVE: 0, NEEDS_WORK: 0, BLOCK: 0 }
  const reposSeen = new Set<string>()
  const languagesSeen = new Set<string>()   // from review_started log events
  const reviewerStats = new Map<string, { attempts: number; successes: number }>()

  for (const e of allEntries) {
    if (e.repo) reposSeen.add(e.repo)

    if (e.event === 'review_started') {
      const key = `${e.repo}#${e.pr}`
      started.set(key, e)
      const r = e.reviewer ?? 'unknown'
      if (!reviewerStats.has(r)) reviewerStats.set(r, { attempts: 0, successes: 0 })
      reviewerStats.get(r)!.attempts++
      // Collect languages detected at review time
      if (Array.isArray(e['languages'])) {
        for (const lang of e['languages'] as string[]) languagesSeen.add(lang)
      }
    }

    if (e.event === 'review_complete') {
      const key = `${e.repo}#${e.pr}`
      completed.add(key)
      const r = e.reviewer ?? 'unknown'
      const stats = reviewerStats.get(r)
      if (stats) stats.successes++
      if (e.verdict) {
        const v = e.verdict as keyof typeof verdicts
        if (v in verdicts) verdicts[v]++
      }
    }

    if (e.event === 'error' && e.level === 'error') {
      const msg = e.message ?? ''
      const { pattern, command, branch } = classifyError(msg)

      const reviewerMatch = msg.match(/^(codex|claude):/i)
      const reviewer = reviewerMatch ? reviewerMatch[1].toLowerCase() : undefined

      const mapKey = pattern === 'command_not_found' ? `cmd:${command}` : pattern
      if (errorPatterns.has(mapKey)) {
        errorPatterns.get(mapKey)!.count++
      } else {
        errorPatterns.set(mapKey, { pattern, command, branch, count: 1, reviewer })
      }
    }
  }

  const errors = [...errorPatterns.values()].sort((a, b) => b.count - a.count)
  // Merge: languages from log events + languages inferred from command errors
  const languagesFromErrors = detectLanguagesFromCommands(errors)
  const languages = [...new Set([...languagesSeen, ...languagesFromErrors])]
  const suggestions = buildSuggestions(errors, languages)

  const fromDate = files[0]?.split('/').at(-1)?.replace('.ndjson', '') ?? 'N/A'
  const toDate = files.at(-1)?.split('/').at(-1)?.replace('.ndjson', '') ?? 'N/A'

  const totalReviews = started.size
  const successfulReviews = completed.size
  // Any review_started without a review_complete is a failure
  const failedReviews = totalReviews - successfulReviews

  const reviewer_performance: Record<string, ReviewerPerf> = {}
  for (const [name, stats] of reviewerStats.entries()) {
    reviewer_performance[name] = {
      attempts: stats.attempts,
      successes: stats.successes,
      failure_rate: stats.attempts > 0 ? (stats.attempts - stats.successes) / stats.attempts : 0,
    }
  }

  return {
    period: { from: fromDate, to: toDate, log_files: files.length },
    summary: {
      total_reviews: totalReviews,
      successful: successfulReviews,
      failed: failedReviews,
      failure_rate: totalReviews > 0 ? failedReviews / totalReviews : 0,
    },
    errors,
    verdict_distribution: verdicts,
    repos_seen: [...reposSeen],
    languages_detected: languages,
    reviewer_performance,
    suggestions,
  }
}

function pct(n: number, total: number): string {
  return total === 0 ? '—' : `${Math.round((n / total) * 100)}%`
}

function printReport(report: DiagnoseReport): void {
  const { period, summary, errors, verdict_distribution: vd, reviewer_performance: rp, suggestions } = report
  const total = vd.APPROVE + vd.NEEDS_WORK + vd.BLOCK

  console.log(chalk.bold('\ncrosscheck diagnose\n'))
  console.log(chalk.dim(`  Period   ${period.from} → ${period.to}  (${period.log_files} log file${period.log_files !== 1 ? 's' : ''})`))
  console.log()

  console.log(chalk.dim('  Reviews'))
  console.log(`    total       ${summary.total_reviews}`)
  console.log(`    successful  ${chalk.green(summary.successful)}`)
  console.log(`    failed      ${summary.failed > 0 ? chalk.red(summary.failed) : chalk.green(summary.failed)}  ${summary.failed > 0 ? chalk.dim(`(${pct(summary.failed, summary.total_reviews)} failure rate)`) : ''}`)
  console.log()

  if (Object.keys(rp).length > 0) {
    console.log(chalk.dim('  Reviewer performance'))
    for (const [name, perf] of Object.entries(rp)) {
      const rate = perf.attempts > 0 ? Math.round((perf.successes / perf.attempts) * 100) : 0
      const indicator = rate >= 80 ? chalk.green(`${rate}%`) : rate >= 50 ? chalk.yellow(`${rate}%`) : chalk.red(`${rate}%`)
      console.log(`    ${name.padEnd(8)} ${perf.successes}/${perf.attempts} success  ${indicator}`)
    }
    console.log()
  }

  if (total > 0) {
    console.log(chalk.dim('  Verdict distribution'))
    console.log(`    APPROVE     ${vd.APPROVE}  ${chalk.dim(pct(vd.APPROVE, total))}`)
    console.log(`    NEEDS WORK  ${vd.NEEDS_WORK}  ${chalk.dim(pct(vd.NEEDS_WORK, total))}`)
    console.log(`    BLOCK       ${vd.BLOCK}  ${chalk.dim(pct(vd.BLOCK, total))}`)
    console.log()
  }

  if (errors.length > 0) {
    console.log(chalk.dim('  Error patterns'))
    for (const e of errors) {
      const label = e.pattern === 'command_not_found' ? `command not found: ${e.command}`
        : e.pattern === 'base_branch_missing' ? `base branch missing: ${e.branch}`
        : e.pattern
      console.log(`    ${chalk.red('✗')} ${label.padEnd(40)} ×${e.count}${e.reviewer ? chalk.dim(`  (${e.reviewer})`) : ''}`)
    }
    console.log()
  }

  if (report.languages_detected.length > 0) {
    console.log(chalk.dim('  Languages detected'))
    console.log(`    ${report.languages_detected.join(', ')}`)
    console.log()
  }

  if (suggestions.length > 0) {
    console.log(chalk.dim('  Suggestions'))
    for (const s of suggestions) {
      const icon = s.type === 'add_constraint' ? chalk.yellow('→') : chalk.dim('→')
      console.log(`    ${icon} ${s.reason}`)
      if (s.instruction) console.log(`      ${chalk.cyan(`add to instructions.md: "${s.instruction}"`)}`)
    }
    console.log()
    console.log(chalk.dim('  Run `crosscheck optimize` to apply suggestions automatically.'))
  } else if (summary.total_reviews > 0) {
    console.log(chalk.green('  ✓ No actionable issues found.'))
  }

  console.log()
}

export async function runDiagnose(opts: { json?: boolean; since?: string }): Promise<void> {
  if (!existsSync(LOG_DIR)) {
    if (opts.json) {
      console.log(JSON.stringify({ error: 'No log directory found. Run crosscheck watch or serve first.' }))
    } else {
      console.error(chalk.yellow('No logs found. Run `crosscheck watch` or `crosscheck serve` first.'))
    }
    return
  }

  const report = buildDiagnoseReport(opts.since, LOG_DIR)

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  printReport(report)
}
