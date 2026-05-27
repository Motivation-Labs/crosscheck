import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

const DEFAULT_CACHE_FILE = join(homedir(), '.crosscheck', 'diff-hashes.json')
const DEFAULT_MAX_ENTRIES = 1000

export interface DiffHashEntry {
  sha: string
  hash: string
}

// SHA-256 hex digest of `git diff origin/<baseRef>...HEAD --no-color` run inside tmpDir.
// Identical patch content always produces the same hash regardless of commit SHA, so
// force-pushes, amends, and rebases that don't change the diff vs base collapse to one hash.
export function computeDiffHash(tmpDir: string, baseRef: string): string {
  const out = execFileSync(
    'git',
    ['diff', `origin/${baseRef}...HEAD`, '--no-color'],
    { cwd: tmpDir, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  return createHash('sha256').update(out).digest('hex')
}

// A persistent map of `${owner}/${repo}#${pr}` → { sha, hash } of the last successfully-reviewed
// HEAD. Lets the watcher skip a re-review when a new push produces a different SHA but the same
// diff vs base (force-push, amend, no-op rebase). Mirrors PersistentShaSet — load on construct,
// write on mutate. FIFO eviction at maxEntries; older insertions go first.
export class PersistentDiffHashMap {
  private readonly file: string
  private readonly maxEntries: number
  private readonly entries: Map<string, DiffHashEntry>

  constructor(file: string = DEFAULT_CACHE_FILE, maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.file = file
    this.maxEntries = maxEntries
    this.entries = new Map()
    this.load()
  }

  get(key: string): DiffHashEntry | undefined {
    return this.entries.get(key)
  }

  upsert(key: string, entry: DiffHashEntry): void {
    if (this.entries.has(key)) {
      // Overwrite without disturbing FIFO position
      this.entries.set(key, entry)
    } else {
      this.entries.set(key, entry)
      while (this.entries.size > this.maxEntries) {
        const oldest = this.entries.keys().next().value
        if (oldest === undefined) break
        this.entries.delete(oldest)
      }
    }
    this.save()
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, DiffHashEntry>
      for (const [k, v] of Object.entries(parsed)) {
        if (v && typeof v.sha === 'string' && typeof v.hash === 'string') {
          this.entries.set(k, v)
        }
      }
    } catch {
      // malformed file → start empty; will be rewritten on next upsert
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.entries)), 'utf8')
    } catch { /* best-effort */ }
  }
}
