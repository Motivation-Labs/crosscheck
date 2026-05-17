import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync, mkdirSync, utimesSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { acquirePRLock, releasePRLock } from '../lib/pr-lock.js'

const OWNER = 'test-owner'
const REPO = 'test-repo'
const PR = 999
const SHA = 'abc12345def67890'

afterEach(() => {
  releasePRLock(OWNER, REPO, PR, SHA)
  releasePRLock(OWNER, REPO, PR + 1, SHA)
})

describe('acquirePRLock', () => {
  it('returns true on first acquisition', () => {
    expect(acquirePRLock(OWNER, REPO, PR, SHA)).toBe(true)
  })

  it('returns false when lock is already held for same SHA', () => {
    acquirePRLock(OWNER, REPO, PR, SHA)
    expect(acquirePRLock(OWNER, REPO, PR, SHA)).toBe(false)
  })

  it('returns true for a different SHA on the same PR', () => {
    acquirePRLock(OWNER, REPO, PR, SHA)
    const newSha = 'ffffffff00000000'
    expect(acquirePRLock(OWNER, REPO, PR, newSha)).toBe(true)
    releasePRLock(OWNER, REPO, PR, newSha)
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
    const stalePath = join(lockDir, `${OWNER}-${REPO}-${PR}-${SHA.slice(0, 8)}.lock`)
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
