import { execa } from 'execa'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { QualityConfig, CodexVendorConfig } from '../config/schema.js'
import { DEFAULT_REVIEW_INSTRUCTIONS } from '../lib/workflow.js'
import { resolveCodexModel } from '../lib/review-models.js'
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
  const model = resolveCodexModel(quality, vendor)
  const tmpFile = join(mkdtempSync(join(tmpdir(), 'crosscheck-')), 'review.md')

  // --base and [PROMPT] are mutually exclusive in codex review;
  // inject focus instructions via a .codex/instructions file instead
  const focusNote = quality.focus.length > 0
    ? `Focus areas: ${quality.focus.join(', ')}. `
    : ''
  const customNote = quality.custom_prompt ?? ''
  const behaviorInstructions = stepInstructions ?? DEFAULT_REVIEW_INSTRUCTIONS
  const instructionsNote = [focusNote, customNote, behaviorInstructions].filter(Boolean).join('\n\n')
  const instructionsPath = `${repoDir}/.codex/instructions`
  // Save original content so we can restore it after the review — prevents the
  // fix step's git add -A from committing crosscheck's instructions as a PR change.
  let originalInstructions: string | undefined
  try { originalInstructions = readFileSync(instructionsPath, 'utf8') } catch { /* didn't exist */ }
  mkdirSync(`${repoDir}/.codex`, { recursive: true })
  writeFileSync(instructionsPath, instructionsNote)

  // Explicit vendor override wins; otherwise fall back to the tier-based default.
  const timeoutMs = vendor.timeout_sec != null
    ? vendor.timeout_sec * 1000
    : (TIER_TIMEOUT_MS[quality.tier] ?? 600_000)

  try {
    const modelArgs = model !== 'default' ? ['-c', `model="${model}"`] : []
    onLog?.(`  running: codex review --base ${baseBranch}${model !== 'default' ? ` -c model="${model}"` : ''}`)

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
    return { review, tokensUsed, model }
  } catch (err: unknown) {
    const execa = err as { stdout?: string; stderr?: string; message?: string; exitCode?: number; timedOut?: boolean }
    const rawStderr = execa.stderr ?? ''
    const timeoutSec = timeoutMs / 1000
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
    // Restore .codex/instructions to its pre-review state so the fix step's
    // git add -A doesn't commit crosscheck's instructions as a PR file change.
    try {
      if (originalInstructions !== undefined) {
        writeFileSync(instructionsPath, originalInstructions)
      } else {
        rmSync(instructionsPath, { force: true })
      }
    } catch { /* ignore */ }
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
