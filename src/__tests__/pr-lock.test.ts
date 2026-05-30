import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync, mkdirSync, utimesSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { acquirePRLock, releasePRLock, handleLockSignal } from '../lib/pr-lock.js'

const OWNER = 'test-owner'
const REPO = 'test-repo'
const PR = 999
const SHA = 'abc12345def67890'

afterEach(() => {
  releasePRLock(OWNER, REPO, PR, SHA)
  releasePRLock(OWNER, REPO, PR + 1, SHA)
  releasePRLock(OWNER, REPO, PR, 'ffffffff00000000')
})

describe('acquirePRLock', () => {
  it('returns true on first acquisition', () => {
    expect(acquirePRLock(OWNER, REPO, PR, SHA)).toBe(true)
  })

  it('returns false when lock is already held for same SHA', () => {
    acquirePRLock(OWNER, REPO, PR, SHA)
    expect(acquirePRLock(OWNER, REPO, PR, SHA)).toBe(false)
  })

  it('returns false for a different SHA on the same PR', () => {
    acquirePRLock(OWNER, REPO, PR, SHA)
    const newSha = 'ffffffff00000000'
    expect(acquirePRLock(OWNER, REPO, PR, newSha)).toBe(false)
  })

  it('returns true after lock is released', () => {
    acquirePRLock(OWNER, REPO, PR, SHA)
    releasePRLock(OWNER, REPO, PR, SHA)
    expect(acquirePRLock(OWNER, REPO, PR, SHA)).toBe(true)
  })

  it('does not conflict across different PR numbers', () => {
    expect(acquirePRLock(OWNER, REPO, PR, SHA)).toBe(true)
    expect(acquirePRLock(OWNER, REPO, PR + 1, SHA)).toBe(true)
  })

  it('acquires a stale lock (mtime > 20 min)', () => {
    const lockDir = join(homedir(), '.crosscheck', 'locks')
    mkdirSync(lockDir, { recursive: true })
    const stalePath = join(lockDir, `${OWNER}-${REPO}-${PR}.lock`)
    writeFileSync(stalePath, '')
    // Back-date the mtime to 21 minutes ago
    const staleTime = new Date(Date.now() - 21 * 60 * 1000)
    utimesSync(stalePath, staleTime, staleTime)
    expect(acquirePRLock(OWNER, REPO, PR, SHA)).toBe(true)
  })
})

describe('releasePRLock', () => {
  it('does not throw when lock file does not exist', () => {
    expect(() => releasePRLock(OWNER, REPO, PR, SHA)).not.toThrow()
  })
})

describe('handleLockSignal', () => {
  // process.kill would actually deliver the signal to the test runner and
  // terminate it. We stub it out and assert the call shape instead. Each
  // test snapshots existing SIGINT listeners and restores them afterward so
  // module-level state (acquirePRLock's one-shot register) doesn't bleed
  // across tests.
  let savedListeners: NodeJS.SignalsListener[] = []

  beforeEach(() => {
    savedListeners = process.listeners('SIGINT') as NodeJS.SignalsListener[]
    for (const l of savedListeners) process.removeListener('SIGINT', l)
  })

  afterEach(() => {
    for (const l of process.listeners('SIGINT')) process.removeListener('SIGINT', l as NodeJS.SignalsListener)
    for (const l of savedListeners) process.on('SIGINT', l)
  })

  it('removes active lock files when signal fires', () => {
    acquirePRLock(OWNER, REPO, PR, SHA)
    const lockFile = join(homedir(), '.crosscheck', 'locks', `${OWNER}-${REPO}-${PR}.lock`)
    expect(existsSync(lockFile)).toBe(true)

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      handleLockSignal('SIGINT')
      expect(existsSync(lockFile)).toBe(false)
    } finally {
      killSpy.mockRestore()
    }
  })

  it('re-raises the signal to terminate the process when it is the sole listener', () => {
    process.on('SIGINT', handleLockSignal)
    expect(process.listenerCount('SIGINT')).toBe(1)

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      handleLockSignal('SIGINT')
      expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGINT')
      // Should have removed itself before re-raising so the default action takes over
      expect(process.listenerCount('SIGINT')).toBe(0)
    } finally {
      killSpy.mockRestore()
    }
  })

  it('does not re-raise when another listener exists (lets graceful-shutdown handlers drive exit)', () => {
    process.on('SIGINT', handleLockSignal)
    const otherListener = (): void => { /* watch/serve graceful shutdown shape */ }
    process.on('SIGINT', otherListener)
    expect(process.listenerCount('SIGINT')).toBe(2)

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      handleLockSignal('SIGINT')
      expect(killSpy).not.toHaveBeenCalled()
      // Our handler should still be registered — only the sole-listener path removes it
      expect(process.listenerCount('SIGINT')).toBe(2)
    } finally {
      killSpy.mockRestore()
    }
  })
})
