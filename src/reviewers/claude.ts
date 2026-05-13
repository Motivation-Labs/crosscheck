import { execa } from 'execa'
import type { QualityConfig, VendorConfig } from '../config/schema.js'
import { DEFAULT_REVIEW_INSTRUCTIONS } from '../lib/workflow.js'

const TIER_MODELS: Record<string, string> = {
  fast: 'claude-haiku-4-5-20251001',
  balanced: 'claude-sonnet-4-6',
  thorough: 'claude-opus-4-7',
}

const EFFORT_MAP: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'max',
}

export async function runClaudeReview(
  repoDir: string,
  baseBranch: string,
  prTitle: string,
  quality: QualityConfig,
  vendor: VendorConfig,
  perReviewBudget: number,
  stepInstructions?: string,
  onLog?: (msg: string) => void,
): Promise<string> {
  const model = TIER_MODELS[quality.tier] ?? 'claude-sonnet-4-6'
  const effort = EFFORT_MAP[vendor.effort] ?? 'medium'
  const focusLine = quality.focus.length > 0
    ? `Focus areas: ${quality.focus.join(', ')}.`
    : ''
  const customLine = quality.custom_prompt ?? ''

  const behaviorInstructions = stepInstructions ?? DEFAULT_REVIEW_INSTRUCTIONS

  const prompt = [
    `You are reviewing a pull request titled: "${prTitle}".`,
    `The branch \`${baseBranch}\` is the base. Review only the changes introduced in this PR.`,
    focusLine,
    customLine,
    behaviorInstructions,
  ].filter(Boolean).join('\n')

  const args = [
    '--print',
    '--model', model,
    '--effort', effort,
    '--max-budget-usd', String(perReviewBudget),
    '--allowedTools', 'Bash(git diff),Bash(git log)',
  ]

  onLog?.(`  running: claude --print --model ${model} --effort ${effort}`)

  try {
    const { stdout } = await execa('claude', args, {
      cwd: repoDir,
      timeout: 180_000,
      input: prompt,
      env: { ...process.env },
    })
    return stdout.trim()
  } catch (err: unknown) {
    const execa = err as { stdout?: string; stderr?: string; message?: string; exitCode?: number; timedOut?: boolean }
    const rawStderr = execa.stderr?.trim() ?? ''
    const summary = (rawStderr.split('\n').filter(Boolean).at(-1)) ?? execa.message ?? 'unknown error'
    const thrown = Object.assign(new Error(`claude: ${summary}`), {
      exitCode: execa.exitCode,
      timedOut: execa.timedOut,
      stderr: rawStderr,
    })
    throw thrown
  }
}

export async function checkClaudeAuth(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { stdout } = await execa('claude', ['--version'], { timeout: 10_000 })
    return { ok: true, detail: stdout.trim() }
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string }
    return { ok: false, detail: error.stderr ?? error.message ?? 'not found' }
  }
}
