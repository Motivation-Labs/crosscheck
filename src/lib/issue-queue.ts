import { mkdirSync, writeFileSync, readdirSync, readFileSync, renameSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export const ISSUE_QUEUE_DIR = join(homedir(), '.crosscheck', 'issues')

export interface IssueQueueRecord {
  ts: string
  pr_url: string
  repo: string
  pr_number: number
  context: string
  user_anticipation: string
  current_status: string
  source: 'diagnose-pr'
}

export function saveToIssueQueue(record: IssueQueueRecord): string {
  mkdirSync(ISSUE_QUEUE_DIR, { recursive: true })
  const filename = `diagnose-${Date.now()}.json`
  const filepath = join(ISSUE_QUEUE_DIR, filename)
  writeFileSync(filepath, JSON.stringify(record, null, 2))
  return filepath
}

export function loadIssueQueue(): Array<{ path: string; record: IssueQueueRecord }> {
  if (!existsSync(ISSUE_QUEUE_DIR)) return []
  const result: Array<{ path: string; record: IssueQueueRecord }> = []
  for (const f of readdirSync(ISSUE_QUEUE_DIR).sort()) {
    if (!f.endsWith('.json') || f.endsWith('.done.json')) continue
    const filepath = join(ISSUE_QUEUE_DIR, f)
    try {
      const record = JSON.parse(readFileSync(filepath, 'utf8')) as IssueQueueRecord
      result.push({ path: filepath, record })
    } catch { /* skip malformed */ }
  }
  return result
}

export function markQueueItemDone(filepath: string): void {
  const donePath = filepath.replace(/\.json$/, '.done.json')
  try { renameSync(filepath, donePath) } catch { /* ignore */ }
}
