import { openSync, closeSync, rmSync, mkdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const LOCK_DIR = join(homedir(), '.crosscheck', 'locks')
const STALE_MS = 20 * 60 * 1000

// Track active lock paths so signal handlers can clean them up
const activeLocks = new Set<string>()
let signalHandlersRegistered = false

// Exported for unit testing. Cleans up local lock files on signal, then —
// when no other listener will drive termination — restores the default
// behavior so the process actually exits.
//
// Background: registering ANY listener on SIGINT/SIGTERM suppresses Node's
// default exit. Previously this handler only deleted the lock and never
// terminated, so Ctrl-C during `crosscheck run` left the process running
// with its lock already removed — letting a second same-machine session
// start the same review concurrently. Now we re-raise after removing
// ourselves so default exit (or another graceful-shutdown handler in
// watch/serve) takes over. When OTHER listeners are registered (the
// watch/serve graceful shutdown handlers referenced in the original
// comment), we let them drive termination via their own finally blocks.
export function handleLockSignal(signal: NodeJS.Signals): void {
  for (const p of activeLocks) {
    try { rmSync(p) } catch { /* ignore */ }
  }
  activeLocks.clear()
  if (process.listenerCount(signal) <= 1) {
    process.removeListener(signal, handleLockSignal)
    process.kill(process.pid, signal)
  }
}

function registerSignalCleanup() {
  if (signalHandlersRegistered) return
  signalHandlersRegistered = true
  process.on('SIGTERM', handleLockSignal)
  process.on('SIGINT', handleLockSignal)
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
