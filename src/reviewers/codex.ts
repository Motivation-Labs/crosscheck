import { execa } from 'execa'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { QualityConfig } from '../config/schema.js'

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

export async function runCodexReview(
  repoDir: string,
  baseBranch: string,
  prTitle: string,
  quality: QualityConfig,
  overrideModel?: string,
  authMode: 'subscription' | 'api-key' = 'subscription',
  onLog?: (msg: string) => void,
): Promise<string> {
  // subscription auth has a fixed model set by ChatGPT plan; only override for api-key
  const model = authMode === 'api-key'
    ? (overrideModel ?? TIER_MODELS_API[quality.tier] ?? 'o4-mini')
    : undefined
  const tmpFile = join(mkdtempSync(join(tmpdir(), 'crosscheck-')), 'review.md')

  // --base and [PROMPT] are mutually exclusive in codex review;
  // inject focus instructions via a .codex/instructions file instead
  const focusNote = quality.focus.length > 0
    ? `Focus areas: ${quality.focus.join(', ')}. `
    : ''
  const customNote = quality.custom_prompt ?? ''
  const verdictNote = [
    'On the very last line of your response, write exactly one of:',
    'VERDICT: APPROVE',
    'VERDICT: NEEDS WORK',
    'VERDICT: BLOCK',
    'Use APPROVE for no issues or trivial nits. Use NEEDS WORK for addressable issues that are not blocking. Use BLOCK for security risks, data loss, broken API contracts, or correctness bugs.',
  ].join('\n')
  // Prevent codex from running build/compile tools that are not installed in the
  // temporary clone (no node_modules, no global tsc/jest/etc).
  const noBuildToolsNote = 'Do not run tsc, npm, yarn, pnpm, jest, pytest, or any build, compile, or test commands. Base your review solely on reading source files and the diff.'
  const instructionsNote = [focusNote, customNote, noBuildToolsNote, verdictNote].filter(Boolean).join('\n\n')
  mkdirSync(`${repoDir}/.codex`, { recursive: true })
  writeFileSync(`${repoDir}/.codex/instructions`, instructionsNote)

  try {
    const modelArgs = model ? ['-c', `model="${model}"`] : []
    onLog?.(`  running: codex review --base ${baseBranch}${model ? ` -c model="${model}"` : ''}`)

    const result = await execa(
      'codex',
      ['review', '--base', baseBranch, '--title', prTitle, ...modelArgs],
      {
        cwd: repoDir,
        timeout: 120_000,
        env: {
          ...process.env,
          // Make local dev tools (tsc, jest, etc.) findable if node_modules exists
          PATH: `${repoDir}/node_modules/.bin:${process.env.PATH ?? ''}`,
        },
      },
    )

    return result.stdout.trim() || result.stderr.trim()
  } catch (err: unknown) {
    const execa = err as { stdout?: string; stderr?: string; message?: string; exitCode?: number; timedOut?: boolean }
    const rawStderr = execa.stderr ?? ''
    const summary = extractErrorSummary(rawStderr) ?? execa.message ?? 'unknown error'
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
