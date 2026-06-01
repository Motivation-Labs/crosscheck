import { execa } from 'execa'
import type { QualityConfig, VendorConfig } from '../config/schema.js'
import { DEFAULT_REVIEW_INSTRUCTIONS } from '../lib/workflow.js'
import { resolveClaudeModel } from '../lib/review-models.js'

const EFFORT_MAP: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'max',
}

export interface ReviewResult {
  review: string
  tokensUsed?: number
  model: string
}

interface ClaudeJsonOutput {
  result?: unknown
  usage?: {
    input_tokens?: unknown
    output_tokens?: unknown
  }
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
  timeoutMs?: number,
): Promise<ReviewResult> {
  const model = resolveClaudeModel(quality)
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
    '--output-format', 'json',
    '--model', model,
    '--effort', effort,
    '--max-budget-usd', String(perReviewBudget),
    '--allowedTools', 'Bash(git diff),Bash(git log)',
  ]

  onLog?.(`  running: claude --print --model ${model} --effort ${effort}`)

  // timeoutMs: 0 → no cap (crazy/halfcrazy); undefined → 180s default; positive → user-specified
  const resolvedTimeout = timeoutMs === undefined ? 180_000 : timeoutMs === 0 ? undefined : timeoutMs

  try {
    const { stdout } = await execa('claude', args, {
      cwd: repoDir,
      timeout: resolvedTimeout,
      input: prompt,
      env: { ...process.env },
    })
    const raw = stdout.trim()
    try {
      const parsed: ClaudeJsonOutput = JSON.parse(raw)
      const review = typeof parsed.result === 'string' ? parsed.result.trim() : raw
      const inTok = parsed.usage?.input_tokens
      const outTok = parsed.usage?.output_tokens
      const tokensUsed = typeof inTok === 'number' && typeof outTok === 'number'
        ? inTok + outTok
        : undefined
      return { review, tokensUsed, model }
    } catch {
      return { review: raw, model }
    }
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
