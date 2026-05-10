import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, mkdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, resolve } from 'path'
import { tmpdir, homedir } from 'os'
import chalk from 'chalk'
import { execa } from 'execa'
import yaml from 'js-yaml'
import { loadConfig } from '../config/loader.js'
import type { Config } from '../config/schema.js'
import { DEFAULT_REVIEW_INSTRUCTIONS } from '../lib/workflow.js'
import { buildDiagnoseReport, type DiagnoseReport } from './diagnose.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// dist/commands/ → ../../ = package root
const PACKAGE_ROOT = resolve(__dirname, '..', '..')

type Agent = 'claude' | 'codex'

export function selectOptimizeAgent(
  config: Config,
  report: DiagnoseReport,
): { agent: Agent; reason: string } {
  const enabled: Agent[] = []
  if (config.vendors.claude.enabled) enabled.push('claude')
  if (config.vendors.codex.enabled) enabled.push('codex')

  if (enabled.length === 0) throw new Error('No vendors enabled in config — enable claude or codex under vendors.')
  if (enabled.length === 1) return { agent: enabled[0], reason: `only enabled vendor in config` }

  // Both enabled — pick by success rate from log data
  const cp = report.reviewer_performance['claude']
  const xp = report.reviewer_performance['codex']

  if (cp?.attempts > 0 && xp?.attempts > 0) {
    const cr = cp.successes / cp.attempts
    const xr = xp.successes / xp.attempts
    if (xr > cr) return { agent: 'codex', reason: `codex success rate ${Math.round(xr * 100)}% > claude ${Math.round(cr * 100)}%` }
    if (cr > xr) return { agent: 'claude', reason: `claude success rate ${Math.round(cr * 100)}% > codex ${Math.round(xr * 100)}%` }
  }

  return { agent: 'claude', reason: 'default (both enabled, no data or equal rates)' }
}

function findAgentMd(cwd: string): string {
  const candidates = [
    join(cwd, 'AGENT.md'),
    join(cwd, '.crosscheck', 'AGENT.md'),
    join(PACKAGE_ROOT, 'AGENT.md'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, 'utf8')
  }
  throw new Error(`AGENT.md not found. Expected at ${candidates[2]}`)
}

// Minimal LCS-based unified diff for display
function unifiedDiff(oldText: string, newText: string): string {
  if (oldText === newText) return ''

  const a = oldText.split('\n')
  const b = newText.split('\n')
  const m = a.length, n = b.length

  // LCS via DP
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])

  const lines: string[] = []
  let i = 0, j = 0
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) {
      lines.push(` ${a[i]}`); i++; j++
    } else if (j < n && (i >= m || dp[i + 1][j] >= dp[i][j + 1])) {
      lines.push(chalk.green(`+${b[j]}`)); j++
    } else {
      lines.push(chalk.red(`-${a[i]}`)); i++
    }
  }

  return lines.filter(l => !l.startsWith(' ')).length > 0
    ? lines.join('\n')
    : ''
}

async function runWithClaude(prompt: string): Promise<string> {
  let result
  try {
    result = await execa('claude', ['--print', '--bare'], {
      input: prompt,
      timeout: 120_000,
      env: { ...process.env },
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/not logged in|please run \/login|run \/login/i.test(msg)) {
      throw new Error('claude is not logged in — run: claude /login')
    }
    throw err
  }
  return (result.stdout ?? result.stderr ?? '').trim()
}

async function runWithCodex(prompt: string): Promise<string> {
  // codex is an agent runner — write the prompt as a file so it can read it,
  // avoiding shell argument length limits on large prompts.
  const tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-optimize-'))
  try {
    writeFileSync(join(tmpDir, 'OPTIMIZE_PROMPT.md'), prompt)
    const result = await execa('codex', [
      '-q',
      'Read OPTIMIZE_PROMPT.md carefully and produce the new instructions.md content. ' +
      'Output only the file content — no explanation, no markdown fences.',
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

export async function runOptimize(opts: {
  apply?: boolean
  dryRun?: boolean
  since?: string
  agent?: string
  config?: string
}): Promise<void> {
  const config = loadConfig(opts.config)
  const cwd = process.cwd()

  // 1. Diagnose
  console.log(chalk.dim('  Running diagnose...'))
  const report = buildDiagnoseReport(opts.since)

  // 2. Select agent
  let selectedAgent: Agent
  let agentReason: string

  if (opts.agent === 'claude' || opts.agent === 'codex') {
    selectedAgent = opts.agent
    agentReason = '--agent flag'
  } else {
    try {
      const sel = selectOptimizeAgent(config, report)
      selectedAgent = sel.agent
      agentReason = sel.reason
    } catch (err) {
      console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
      process.exit(1)
    }
  }

  console.log(`  agent    ${chalk.cyan(selectedAgent)} ${chalk.dim(`(${agentReason})`)}`)

  // 3. Load AGENT.md and current instructions from workflow.yml review step
  let agentMd: string
  try {
    agentMd = findAgentMd(cwd)
  } catch (err) {
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }

  const workflowPath = join(homedir(), '.crosscheck', 'workflow.yml')
  let workflowRaw: Record<string, unknown> = {}
  if (existsSync(workflowPath)) {
    try {
      workflowRaw = (yaml.load(readFileSync(workflowPath, 'utf8')) ?? {}) as Record<string, unknown>
    } catch { /* malformed — start fresh */ }
  }
  const workflowSteps = Array.isArray(workflowRaw.steps)
    ? (workflowRaw.steps as Record<string, unknown>[])
    : []
  const reviewStepIdx = workflowSteps.findIndex(s => s.name === 'review')
  const reviewStep = reviewStepIdx >= 0 ? workflowSteps[reviewStepIdx] : null
  const currentInstructions = typeof reviewStep?.instructions === 'string'
    ? reviewStep.instructions
    : DEFAULT_REVIEW_INSTRUCTIONS
  const instructionsPath = `${workflowPath} (review step)`

  // 4. Build prompt
  const prompt = [
    agentMd,
    '',
    '---',
    '',
    '## Diagnostic report',
    '',
    '```json',
    JSON.stringify(report, null, 2),
    '```',
    '',
    `## Current ${instructionsPath}`,
    '',
    currentInstructions || '(empty)',
  ].join('\n')

  // 5. Run agent
  console.log(chalk.dim(`  Asking ${selectedAgent} to optimize instructions...`))
  let newInstructions: string
  try {
    newInstructions = selectedAgent === 'claude'
      ? await runWithClaude(prompt)
      : await runWithCodex(prompt)
  } catch (err) {
    console.error(chalk.red(`✗ ${selectedAgent} failed: ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }

  if (!newInstructions || newInstructions.length < 20) {
    console.error(chalk.red('✗ Agent returned empty or unusable output'))
    process.exit(1)
  }

  // 6. Diff
  const diff = unifiedDiff(currentInstructions, newInstructions)

  if (!diff) {
    console.log(chalk.green('\n  ✓ Instructions are already optimal — no changes needed.'))
    return
  }

  console.log(chalk.bold(`\n  diff  ${instructionsPath}\n`))
  console.log(diff)
  console.log()

  // 7. Apply or exit
  const apply = opts.apply && !opts.dryRun
  if (apply) {
    mkdirSync(dirname(workflowPath), { recursive: true })
    if (reviewStepIdx >= 0) {
      workflowSteps[reviewStepIdx] = { ...workflowSteps[reviewStepIdx], instructions: newInstructions }
      workflowRaw.steps = workflowSteps
      writeFileSync(workflowPath, yaml.dump(workflowRaw, { lineWidth: -1, noRefs: true }))
    } else {
      // No review step found — write a minimal workflow with the new instructions
      const workflow = {
        on: ['opened', 'synchronize'],
        steps: [{ name: 'review', type: 'review', reviewer: 'auto', max_rounds: 1, instructions: newInstructions }],
      }
      writeFileSync(workflowPath, yaml.dump(workflow, { lineWidth: -1, noRefs: true }))
    }
    console.log(chalk.green(`  ✓ Written to ${workflowPath}`))
    console.log(chalk.dim('  Next reviews will use the updated instructions.'))
  } else {
    console.log(chalk.dim(`  Run with --apply to write changes to ${instructionsPath}`))
  }
}
