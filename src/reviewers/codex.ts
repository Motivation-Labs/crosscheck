import { execa } from 'execa'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { QualityConfig } from '../config/schema.js'

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
  const instructionsNote = [focusNote, customNote].filter(Boolean).join('')
  if (instructionsNote) {
    mkdirSync(`${repoDir}/.codex`, { recursive: true })
    writeFileSync(`${repoDir}/.codex/instructions`, instructionsNote)
  }

  try {
    const modelArgs = model ? ['-c', `model="${model}"`] : []
    onLog?.(`  running: codex review --base ${baseBranch}${model ? ` -c model="${model}"` : ''}`)

    const result = await execa(
      'codex',
      ['review', '--base', baseBranch, '--title', prTitle, ...modelArgs],
      {
        cwd: repoDir,
        timeout: 120_000,
        env: { ...process.env },
      },
    )

    return result.stdout.trim() || result.stderr.trim()
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; message?: string }
    throw new Error(`codex review failed: ${error.stderr ?? error.message ?? 'unknown error'}`)
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
