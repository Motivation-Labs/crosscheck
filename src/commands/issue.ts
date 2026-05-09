import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, resolve } from 'path'
import { homedir, platform, tmpdir } from 'os'
import { createInterface } from 'readline'
import chalk from 'chalk'
import { execa } from 'execa'
import { loadConfig } from '../config/loader.js'
import { buildDiagnoseReport } from './diagnose.js'
import { selectOptimizeAgent } from './optimize.js'
import { sanitizeEntry, loadErrorEntriesForPattern, sanitizeDraftContent } from '../lib/log-analysis.js'
import type { RawLogEntry } from '../lib/log-analysis.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PACKAGE_ROOT = resolve(__dirname, '..', '..')
const LOG_DIR = join(homedir(), '.crosscheck', 'logs')
const ISSUE_REPO = 'Motivation-Labs/crosscheck'

const { version: PKG_VERSION } = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
) as { version: string }

export interface QuestionAnswers {
  reproducibility: string
  trigger: string
  impact: string
}

export function parseDraft(output: string): { title: string; body: string } | null {
  const lines = output.split('\n')
  const titleIdx = lines.findIndex(l => l.startsWith('TITLE:'))
  if (titleIdx === -1) return null

  const title = lines[titleIdx].replace(/^TITLE:\s*/, '').trim()
  if (!title) return null

  let sepIdx = -1
  for (let i = titleIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { sepIdx = i; break }
  }
  if (sepIdx === -1) return null

  const body = lines.slice(sepIdx + 1).join('\n').trim()
  if (!body) return null

  return { title, body }
}

export function buildIssueContent(
  draft: { title: string; body: string },
  answers: QuestionAnswers,
): { title: string; body: string } {
  const context = [
    '',
    '## User Context',
    '',
    `- **Reproducibility:** ${answers.reproducibility}`,
    `- **Trigger command:** ${answers.trigger}`,
    `- **Impact:** ${answers.impact}`,
  ].join('\n')
  return { title: draft.title, body: draft.body + context }
}

function defaultSince(): string {
  const d = new Date()
  d.setDate(d.getDate() - 3)
  return d.toISOString().split('T')[0] as string
}

function daysBetween(since: string): number {
  return Math.max(1, Math.ceil((Date.now() - new Date(since).getTime()) / 86_400_000))
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()) })
  })
}

async function pickOne(label: string, choices: string[]): Promise<number> {
  console.log(`\n  ${label}`)
  choices.forEach((c, i) => console.log(`  [${i + 1}] ${c}`))
  while (true) {
    const raw = await ask('  > ')
    const n = parseInt(raw, 10)
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return n - 1
    console.log(chalk.dim(`  Enter a number from 1 to ${choices.length}`))
  }
}

function buildAgentPrompt(
  errorPattern: string,
  errorCount: number,
  daysSince: number,
  reviewer: string | undefined,
  entries: RawLogEntry[],
  mode: string,
): string {
  const entriesFormatted = entries.map(e => JSON.stringify(sanitizeEntry(e))).join('\n')
  return [
    'You are drafting a GitHub issue for the crosscheck project (a cross-vendor AI code review CLI tool).',
    '',
    `Error pattern: ${errorPattern}`,
    `Frequency: ${errorCount} occurrence${errorCount !== 1 ? 's' : ''} in the last ${daysSince} day${daysSince !== 1 ? 's' : ''}`,
    reviewer ? `Reviewer at time of failure: ${reviewer}` : '',
    '',
    'Sanitized log entries (up to 5 most recent):',
    entriesFormatted || '(none available)',
    '',
    `Environment: crosscheck ${PKG_VERSION} · ${platform()} · mode: ${mode}`,
    '',
    'Write a GitHub issue for this failure. Output exactly:',
    'TITLE: <concise title under 80 characters>',
    '---',
    '<issue body in GitHub-flavored markdown>',
    '',
    'The body must contain: ## Description, ## Steps to Reproduce, ## Log Excerpt, ## Environment',
    'In Log Excerpt, show the sanitized log entries as a json code block.',
    'Do not invent details not present in the provided context.',
  ].filter(Boolean).join('\n')
}

async function runWithClaude(prompt: string): Promise<string> {
  let result
  try {
    result = await execa('claude', ['--print', '--bare', prompt], {
      timeout: 120_000,
      env: { ...process.env },
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/not logged in|please run \/login|run \/login|403|request not allowed|failed to authenticate/i.test(msg)) {
      throw new Error('claude is not authenticated — run: claude /login')
    }
    throw err
  }
  return (result.stdout ?? result.stderr ?? '').trim()
}

async function runWithCodex(prompt: string): Promise<string> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-issue-'))
  try {
    writeFileSync(join(tmpDir, 'ISSUE_PROMPT.md'), prompt)
    const result = await execa('codex', [
      '-q',
      'Read ISSUE_PROMPT.md and produce a GitHub issue draft. ' +
      'Output exactly: TITLE: line, then ---, then the markdown body.',
    ], {
      cwd: tmpDir,
      timeout: 180_000,
      env: { ...process.env },
    })
    return (result.stdout ?? '').trim()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

function printDraft(title: string, body: string): void {
  const width = Math.min(process.stdout.columns ?? 80, 80)
  const bar = '─'.repeat(width)
  console.log('\n' + chalk.dim(bar))
  console.log(chalk.bold(`  TITLE: ${title}`))
  console.log(chalk.dim(bar))
  for (const line of body.split('\n')) {
    console.log(`  ${line}`)
  }
  console.log(chalk.dim(bar) + '\n')
}

function errorLabel(e: { pattern: string; command?: string; branch?: string }): string {
  if (e.pattern === 'command_not_found') return `command not found: ${e.command}`
  if (e.pattern === 'base_branch_missing') return `base branch missing: ${e.branch}`
  return e.pattern
}

export async function runIssue(opts: {
  since?: string
  dryRun?: boolean
  yes?: boolean
  config?: string
}): Promise<void> {
  const since = opts.since ?? defaultSince()

  if (!existsSync(LOG_DIR)) {
    console.error(chalk.yellow('No logs found. Run `crosscheck watch` or `crosscheck serve` first.'))
    return
  }

  // 1. Scan logs for error patterns
  console.log(chalk.dim('  scanning logs...'))
  const report = buildDiagnoseReport(since, LOG_DIR)

  if (report.errors.length === 0) {
    console.log('  No errors found in recent logs — nothing to report')
    return
  }

  // 2. Select which error to report
  let errorIdx = 0
  if (report.errors.length > 1 && !opts.yes) {
    const days = daysBetween(since)
    console.log(chalk.bold(`\n  Found ${report.errors.length} error patterns in the last ${days} day${days !== 1 ? 's' : ''}:\n`))
    report.errors.forEach((e, i) => {
      const label = errorLabel(e).padEnd(44)
      const rev = e.reviewer ? chalk.dim(` ${e.reviewer}`) : ''
      console.log(`  [${i + 1}] ${label} ×${e.count}${rev}`)
    })
    errorIdx = await pickOne(
      'Which issue do you want to report?',
      report.errors.map((_, i) => String(i + 1)),
    )
  }

  const selected = report.errors[errorIdx]
  if (!selected) {
    console.error(chalk.red('✗ Invalid selection'))
    process.exit(1)
  }

  // 3. Load representative log entries for this pattern
  const rawEntries = loadErrorEntriesForPattern(
    selected.pattern,
    selected.command,
    since,
  )

  // 4. Select agent
  const config = loadConfig(opts.config)
  let agentName: 'claude' | 'codex' = 'claude'
  let agentReason = 'default'
  try {
    const sel = selectOptimizeAgent(config, report)
    agentName = sel.agent
    agentReason = sel.reason
  } catch {
    // No vendors configured — fall back to claude
  }

  // 5. Draft issue via AI agent
  const days = daysBetween(since)
  const prompt = buildAgentPrompt(
    errorLabel(selected),
    selected.count,
    days,
    selected.reviewer,
    rawEntries,
    config.mode,
  )

  console.log(chalk.dim(`  drafting issue with ${agentName} (${agentReason})...`))
  let agentOutput: string
  try {
    agentOutput = agentName === 'claude'
      ? await runWithClaude(prompt)
      : await runWithCodex(prompt)
  } catch (err) {
    console.error(chalk.red(`✗ ${agentName} failed: ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }

  const draftParsed = parseDraft(agentOutput)
  if (!draftParsed) {
    console.error(chalk.red('✗ Agent returned unexpected output format'))
    console.error(chalk.dim('  Expected: TITLE: <title>\\n---\\n<body>'))
    process.exit(1)
  }

  // 6. Ask follow-up questions (skipped when --yes)
  let answers: QuestionAnswers = {
    reproducibility: 'Unknown',
    trigger: 'Unknown',
    impact: 'Degraded',
  }

  if (!opts.yes) {
    const repIdx = await pickOne(
      'Can you reproduce this consistently?',
      ['Every time', 'Sometimes', 'Happened once'],
    )
    answers.reproducibility = ['Every time', 'Sometimes', 'Happened once'][repIdx] as string

    const trigIdx = await pickOne(
      'Which command triggered this?',
      ['watch', 'serve', 'review', 'Unknown'],
    )
    answers.trigger = ['watch', 'serve', 'review', 'Unknown'][trigIdx] as string

    const impactIdx = await pickOne(
      'Is this blocking you from using crosscheck?',
      ['Blocked', 'Degraded', 'Cosmetic'],
    )
    answers.impact = ['Blocked', 'Degraded', 'Cosmetic'][impactIdx] as string
  }

  // 7. Build final content and show draft
  // Sanitize AI output before use — the agent may echo back content it received,
  // even if inputs were sanitized; this is the last gate before posting.
  const cleanDraft = sanitizeDraftContent(draftParsed.title, draftParsed.body)
  const { title, body } = buildIssueContent(cleanDraft, answers)
  printDraft(title, body)

  // 8. Submit
  if (opts.dryRun) {
    console.log(chalk.dim('  (dry run — not submitting)'))
    return
  }

  if (!opts.yes) {
    const confirmed = (await ask(`  Submit to ${ISSUE_REPO}? [y/N]: `))
    if (!/^y(es)?$/i.test(confirmed)) {
      console.log('  Cancelled.')
      return
    }
  }

  const labels = ['bug']
  if (answers.impact === 'Blocked') labels.push('priority:high')

  const ghArgs = [
    'issue', 'create',
    '--repo', ISSUE_REPO,
    '--title', title,
    '--body', body,
    ...labels.flatMap(l => ['--label', l]),
  ]

  let issueUrl: string
  try {
    const result = await execa('gh', ghArgs, { timeout: 30_000 })
    issueUrl = (result.stdout ?? '').trim()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/not logged in|not authenticated/i.test(msg)) {
      console.error(chalk.yellow('  gh is not authenticated — run: gh auth login'))
    } else {
      console.error(chalk.yellow(`  gh issue create failed: ${msg}`))
    }
    // Fall back to printing the command the user can run manually
    const escapedTitle = title.replace(/'/g, "'\\''")
    const escapedBody = body.replace(/'/g, "'\\''")
    const labelsStr = labels.map(l => `--label '${l}'`).join(' ')
    console.log('\n  Run this manually:')
    console.log(chalk.cyan(
      `  gh issue create --repo ${ISSUE_REPO} --title '${escapedTitle}' --body '${escapedBody}' ${labelsStr}`,
    ))
    process.exit(2)
  }

  console.log(chalk.green(`\n  ✓ issue created → ${issueUrl}`))
}
