import { execa } from 'execa'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { QualityConfig } from '../config/schema.js'

const TIER_MODELS: Record<string, string> = {
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
  onLog?: (msg: string) => void,
): Promise<string> {
  const model = overrideModel ?? TIER_MODELS[quality.tier] ?? 'o4-mini'
  const focusLine = quality.focus.length > 0
    ? `Focus areas: ${quality.focus.join(', ')}.`
    : ''
  const customLine = quality.custom_prompt ?? ''
  const prompt = [
    `Review this pull request: "${prTitle}".`,
    focusLine,
    customLine,
    'Be concise. Group findings by severity (critical / warning / suggestion).',
  ].filter(Boolean).join(' ')

  const tmpFile = join(mkdtempSync(join(tmpdir(), 'crosscheck-')), 'review.md')

  try {
    onLog?.(`  running: codex review --base ${baseBranch} -c model="${model}"`)

    const result = await execa(
      'codex',
      ['review', '--base', baseBranch, '--title', prTitle, '-c', `model="${model}"`, prompt],
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
