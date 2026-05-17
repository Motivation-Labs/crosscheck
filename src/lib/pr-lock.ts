import { openSync, closeSync, rmSync, mkdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const LOCK_DIR = join(homedir(), '.crosscheck', 'locks')
const STALE_MS = 20 * 60 * 1000

// Track active lock paths so signal handlers can clean them up
const activeLocks = new Set<string>()
let signalHandlersRegistered = false

function registerSignalCleanup() {
  if (signalHandlersRegistered) return
  signalHandlersRegistered = true
  const cleanup = () => {
    for (const p of activeLocks) {
      try { rmSync(p) } catch { /* ignore */ }
    }
    process.exit(1)
  }
  process.once('SIGTERM', cleanup)
  process.once('SIGINT', cleanup)
}

function lockPath(owner: string, repo: string, pr: number, sha: string): string {
  return join(LOCK_DIR, `${owner}-${repo}-${pr}-${sha.slice(0, 8)}.lock`)
}

function isStale(path: string): boolean {
  try {
    const age = Date.now() - statSync(path).mtimeMs
    return age > STALE_MS
  } catch {
    return false
  }
}

export function acquirePRLock(owner: string, repo: string, pr: number, sha: string): boolean {
  mkdirSync(LOCK_DIR, { recursive: true })
  registerSignalCleanup()
  const path = lockPath(owner, repo, pr, sha)
  try {
    const fd = openSync(path, 'wx')
    closeSync(fd)
    activeLocks.add(path)
    return true
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    if (isStale(path)) {
      try { rmSync(path) } catch { /* already gone */ }
      try {
        const fd = openSync(path, 'wx')
        closeSync(fd)
        activeLocks.add(path)
        return true
      } catch { /* lost the race after clearing stale lock */ }
    }
    return false
  }
}

export function releasePRLock(owner: string, repo: string, pr: number, sha: string): void {
  const path = lockPath(owner, repo, pr, sha)
  activeLocks.delete(path)
  try { rmSync(path) } catch { /* already gone */ }
}
