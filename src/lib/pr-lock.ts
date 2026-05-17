import { openSync, closeSync, rmSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const LOCK_DIR = join(homedir(), '.crosscheck', 'locks')

export function acquirePRLock(owner: string, repo: string, pr: number): boolean {
  mkdirSync(LOCK_DIR, { recursive: true })
  const lockPath = join(LOCK_DIR, `${owner}-${repo}-${pr}.lock`)
  try {
    const fd = openSync(lockPath, 'wx')
    closeSync(fd)
    return true
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw e
  }
}

export function releasePRLock(owner: string, repo: string, pr: number): void {
  try {
    rmSync(join(LOCK_DIR, `${owner}-${repo}-${pr}.lock`))
  } catch { /* already gone */ }
}
