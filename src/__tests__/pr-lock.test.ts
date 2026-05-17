import { describe, it, expect, afterEach } from 'vitest'
import { acquirePRLock, releasePRLock } from '../lib/pr-lock.js'

const OWNER = 'test-owner'
const REPO = 'test-repo'
const PR = 999

afterEach(() => {
  releasePRLock(OWNER, REPO, PR)
})

describe('acquirePRLock', () => {
  it('returns true on first acquisition', () => {
    expect(acquirePRLock(OWNER, REPO, PR)).toBe(true)
  })

  it('returns false when lock is already held', () => {
    acquirePRLock(OWNER, REPO, PR)
    expect(acquirePRLock(OWNER, REPO, PR)).toBe(false)
  })

  it('returns true after lock is released', () => {
    acquirePRLock(OWNER, REPO, PR)
    releasePRLock(OWNER, REPO, PR)
    expect(acquirePRLock(OWNER, REPO, PR)).toBe(true)
  })

  it('does not conflict across different PR numbers', () => {
    expect(acquirePRLock(OWNER, REPO, PR)).toBe(true)
    expect(acquirePRLock(OWNER, REPO, PR + 1)).toBe(true)
    releasePRLock(OWNER, REPO, PR + 1)
  })
})

describe('releasePRLock', () => {
  it('does not throw when lock file does not exist', () => {
    expect(() => releasePRLock(OWNER, REPO, PR)).not.toThrow()
  })
})
