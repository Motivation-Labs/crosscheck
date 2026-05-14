import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const CACHE_DIR = join(homedir(), '.crosscheck')
const CACHE_FILE = join(CACHE_DIR, 'pushed-shas.json')
const MAX_SHAS = 500

function loadShas(): string[] {
  try {
    if (!existsSync(CACHE_FILE)) return []
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as string[]
  } catch {
    return []
  }
}

function saveShas(shas: string[]): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(CACHE_FILE, JSON.stringify(shas), 'utf8')
  } catch { /* best-effort */ }
}

// A Set<string> that persists its contents to ~/.crosscheck/pushed-shas.json.
// Loaded on construction so SHAs survive process restarts, preventing crosscheck
// fix commits from triggering redundant re-reviews in a new session.
export class PersistentShaSet extends Set<string> {
  constructor() {
    super(loadShas())
  }

  add(sha: string): this {
    super.add(sha)
    saveShas([...this].slice(-MAX_SHAS))
    return this
  }
}
