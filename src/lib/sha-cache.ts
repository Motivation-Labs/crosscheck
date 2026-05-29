import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'

const DEFAULT_CACHE_FILE = join(homedir(), '.crosscheck', 'pushed-shas.json')
const DEFAULT_MAX_SHAS = 500

function loadShas(file: string): string[] {
  try {
    if (!existsSync(file)) return []
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return Array.isArray(parsed) ? parsed.filter((sha): sha is string => typeof sha === 'string') : []
  } catch {
    return []
  }
}

function saveShas(file: string, shas: string[]): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(shas), 'utf8')
  } catch { /* best-effort */ }
}

// A Set<string> that persists its contents to ~/.crosscheck/pushed-shas.json.
// Loaded on construction so SHAs survive process restarts, preventing crosscheck
// fix commits from triggering redundant re-reviews in a new session.
export class PersistentShaSet extends Set<string> {
  private readonly file: string
  private readonly maxShas: number

  constructor(file: string = DEFAULT_CACHE_FILE, maxShas: number = DEFAULT_MAX_SHAS) {
    super()
    this.file = file
    this.maxShas = maxShas
    for (const sha of loadShas(file).slice(-maxShas)) {
      Set.prototype.add.call(this, sha)
    }
  }

  add(sha: string): this {
    super.add(sha)
    saveShas(this.file, [...this].slice(-this.maxShas))
    return this
  }
}
