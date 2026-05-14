import { execa } from 'execa'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { QualityConfig, CodexVendorConfig } from '../config/schema.js'
import { DEFAULT_REVIEW_INSTRUCTIONS } from '../lib/workflow.js'
import type { ReviewResult } from './claude.js'

// Codex review command outputs [P0]/[P1]/[P2]/[P3] priority markers but never a VERDICT line.
// Infer the verdict from the highest severity present and append it so parseVerdict() can
// extract it. Only called when the output doesn't already contain a VERDICT: token.
export function inferVerdictFromCodexOutput(text: string): string {
  if (/\[P0\]/i.test(text) || /\[P1\]/i.test(text)) return 'BLOCK'
  if (/\[P2\]/i.test(text) || /\[P3\]/i.test(text)) return 'NEEDS WORK'
  return 'APPROVE'
}

// Scans stderr bottom-up for the first fatal/error line, skipping Codex header boilerplate.
function extractErrorSummary(stderr: string): string | undefined {
  const lines = stderr.split('\n').map(l => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]
    if (/^(fatal|error):/i.test(l)) return l
  }
  // Fall back to last non-boilerplate line
  return lines.filter(l =>
    !l.startsWith('---') &&
    !/^(workdir|model|provider|approval|sandbox|reasoning|session\s+id):/i.test(l) &&
    !/^OpenAI Codex/i.test(l)
  ).at(-1)
}

// Models for API-key auth. When using ChatGPT subscription auth, omit model override.
const TIER_MODELS_API: Record<string, string> = {
  fast: 'gpt-4o-mini',
  balanced: 'o4-mini',
  thorough: 'o3',
}

const TIER_TIMEOUT_MS: Record<string, number> = {
  fast: 300_000,
  balanced: 600_000,
  thorough: 1_200_000,
}

export async function runCodexReview(
  repoDir: string,
  baseBranch: string,
  prTitle: string,
  quality: QualityConfig,
  vendor: CodexVendorConfig,
  stepInstructions?: string,
  onLog?: (msg: string) => void,
): Promise<ReviewResult> {
  // subscription auth has a fixed model set by ChatGPT plan; only override for api-key
  const model = vendor.auth === 'api-key'
    ? (vendor.model ?? TIER_MODELS_API[quality.tier] ?? 'o4-mini')
    : undefined
  const tmpFile = join(mkdtempSync(join(tmpdir(), 'crosscheck-')), 'review.md')

  // --base and [PROMPT] are mutually exclusive in codex review;
  // inject focus instructions via a .codex/instructions file instead
  const focusNote = quality.focus.length > 0
    ? `Focus areas: ${quality.focus.join(', ')}. `
    : ''
  const customNote = quality.custom_prompt ?? ''
  const behaviorInstructions = stepInstructions ?? DEFAULT_REVIEW_INSTRUCTIONS
  const instructionsNote = [focusNote, customNote, behaviorInstructions].filter(Boolean).join('\n\n')
  mkdirSync(`${repoDir}/.codex`, { recursive: true })
  writeFileSync(`${repoDir}/.codex/instructions`, instructionsNote)

  try {
    const modelArgs = model ? ['-c', `model="${model}"`] : []
    onLog?.(`  running: codex review --base ${baseBranch}${model ? ` -c model="${model}"` : ''}`)

    const timeoutMs = TIER_TIMEOUT_MS[quality.tier] ?? 600_000
    const result = await execa(
      'codex',
      ['review', '--base', baseBranch, '--title', prTitle, ...modelArgs],
      {
        cwd: repoDir,
        timeout: timeoutMs,
        env: {
          ...process.env,
          // Make local dev tools (tsc, jest, etc.) findable if node_modules exists
          PATH: `${repoDir}/node_modules/.bin:${process.env.PATH ?? ''}`,
        },
      },
    )

    const rawReview = result.stdout.trim() || result.stderr.trim()
    const tokensMatch = (result.stderr ?? '').match(/\btokens?:\s*([\d,]+)/i)
    const tokensUsed = tokensMatch ? parseInt(tokensMatch[1].replace(/,/g, ''), 10) : undefined
    // Append inferred VERDICT when Codex didn't include one (its review command
    // uses [P1]/[P2]/[P3] markers but never emits a VERDICT: line on its own).
    const review = rawReview.includes('VERDICT:')
      ? rawReview
      : `${rawReview}\n\nVERDICT: ${inferVerdictFromCodexOutput(rawReview)}`
    return { review, tokensUsed }
  } catch (err: unknown) {
    const execa = err as { stdout?: string; stderr?: string; message?: string; exitCode?: number; timedOut?: boolean }
    const rawStderr = execa.stderr ?? ''
    const timeoutSec = (TIER_TIMEOUT_MS[quality.tier] ?? 600_000) / 1000
    const summary = execa.timedOut
      ? `timed out after ${timeoutSec}s — PR diff may be too large (tier: ${quality.tier})`
      : (extractErrorSummary(rawStderr) ?? execa.message ?? 'unknown error')
    const thrown = Object.assign(new Error(`codex: ${summary}`), {
      exitCode: execa.exitCode,
      timedOut: execa.timedOut,
      stderr: rawStderr,
    })
    throw thrown
  } finally {
    try { rmSync(tmpFile, { force: true, recursive: true }) } catch { /* ignore */ }
  }
}

export async function checkCodexAuth(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { stdout } = await execa('codex', ['login', 'status'], { timeout: 10_000 })
    return { ok: true, detail: stdout.trim() }
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string }
    return { ok: false, detail: error.stderr ?? error.message ?? 'not authenticated' }
  }
}
