import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { execa } from 'execa'
import { applyEdit } from './fix.js'

interface ClaudeJsonOutput {
  result?: unknown
  usage?: { input_tokens?: unknown; output_tokens?: unknown }
}

const PROMPT_TEMPLATE = `This pull request has merge conflicts. Resolve all conflict markers in the files listed below.

PR title: {PR_TITLE}

Conflicted files:
{CONFLICTED_FILES}

{EXTRA_INSTRUCTIONS}

Rules for resolving each conflict:
- Keep ALL meaningful changes from both sides if they are not directly contradictory
- When both sides modify the same line, prefer the incoming branch changes (the >>>>>>> side) unless they clearly break existing logic
- Remove ALL conflict markers: <<<<<<<, =======, >>>>>>>

For each file, output ONLY the resolved conflict regions using this format:

<edit path="relative/path/to/file.ext">
<old>
exact conflict region including all markers (copy verbatim from the file)
</old>
<new>
resolved content with no conflict markers
</new>
</edit>

Rules for <edit> blocks:
- <old> must match the file content EXACTLY, including conflict markers and surrounding lines
- <new> must not contain ANY conflict markers
- Include 2–3 context lines around the conflict region to make the match unambiguous
- One block per conflict region; multiple blocks per file are fine
- Output ONLY <edit> blocks. No other text.`

// Returns file paths that have unmerged conflict markers (git status: UU/AA/DD).
export function findConflictedFiles(tmpDir: string): string[] {
  try {
    const out = execSync('git diff --name-only --diff-filter=U', { cwd: tmpDir, encoding: 'utf8' })
    return out.trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

function buildConflictedFilesBlock(tmpDir: string, filePaths: string[]): string {
  return filePaths.map(f => {
    try {
      const content = readFileSync(join(tmpDir, f), 'utf8').slice(0, 4000)
      return `### ${f}\n\`\`\`\n${content}\n\`\`\``
    } catch {
      return `### ${f}\n(could not read file)`
    }
  }).join('\n\n')
}

export async function runConflictResolveStep(
  tmpDir: string,
  prTitle: string,
  instructions: string,
): Promise<{ appliedCount: number; tokensUsed?: number }> {
  const conflictedFiles = findConflictedFiles(tmpDir)
  if (conflictedFiles.length === 0) return { appliedCount: 0 }

  const filesBlock = buildConflictedFilesBlock(tmpDir, conflictedFiles)
  const prompt = PROMPT_TEMPLATE
    .replace('{PR_TITLE}', prTitle)
    .replace('{CONFLICTED_FILES}', filesBlock)
    .replace('{EXTRA_INSTRUCTIONS}', instructions ? `Additional instructions: ${instructions}` : '')

  let output = ''
  let tokensUsed: number | undefined
  try {
    const { stdout } = await execa('claude', ['--print', '--output-format', 'json'], {
      input: prompt,
      timeout: 180_000,
      env: { ...process.env },
    })
    const raw = stdout.trim()
    try {
      const parsed: ClaudeJsonOutput = JSON.parse(raw)
      output = typeof parsed.result === 'string' ? parsed.result : raw
      const inTok = parsed.usage?.input_tokens
      const outTok = parsed.usage?.output_tokens
      tokensUsed = typeof inTok === 'number' && typeof outTok === 'number' ? inTok + outTok : undefined
    } catch {
      output = raw
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/not logged in|auth|credential/i.test(msg)) {
      throw new Error('claude auth failure during conflict-resolve step — run: claude auth login')
    }
    throw err
  }

  if (!output || output === 'NO_CHANGES') return { appliedCount: 0, tokensUsed }

  let appliedCount = 0
  const editRegex = /<edit path="([^"]+)">([\s\S]*?)<\/edit>/g
  const fileEdits = new Map<string, string>()
  const fileCache = new Map<string, string>()

  let match: RegExpExecArray | null
  while ((match = editRegex.exec(output)) !== null) {
    const [, filePath, body] = match
    if (filePath.includes('..') || filePath.startsWith('/')) continue

    const oldMatch = body.match(/<old>([\s\S]*?)<\/old>/)
    const newMatch = body.match(/<new>([\s\S]*?)<\/new>/)
    if (!oldMatch || !newMatch) continue

    const oldText = oldMatch[1].replace(/^\n/, '').replace(/\n$/, '')
    const newText = newMatch[1].replace(/^\n/, '').replace(/\n$/, '')

    const absPath = join(tmpDir, filePath)
    let current = fileEdits.get(filePath) ?? fileCache.get(filePath)
    if (current === undefined) {
      try {
        current = readFileSync(absPath, 'utf8')
        fileCache.set(filePath, current)
      } catch {
        continue
      }
    }

    if (oldText === '') continue

    const updated = applyEdit(current, oldText, newText)
    if (updated === null) continue
    fileEdits.set(filePath, updated)
  }

  const { writeFileSync, mkdirSync } = await import('fs')
  const { dirname } = await import('path')
  for (const [filePath, content] of fileEdits) {
    const absPath = join(tmpDir, filePath)
    try {
      mkdirSync(dirname(absPath), { recursive: true })
      writeFileSync(absPath, content)
      appliedCount++
    } catch { /* skip unwritable paths */ }
  }

  return { appliedCount, tokensUsed }
}
