import { describe, it, expect } from 'vitest'
import { isAuthorAllowed } from '../lib/filter.js'

describe('isAuthorAllowed', () => {
  it('allows any author when list is empty', () => {
    expect(isAuthorAllowed([], 'alice')).toBe(true)
    expect(isAuthorAllowed([], 'anyone')).toBe(true)
  })

  it('allows a listed author', () => {
    expect(isAuthorAllowed(['alice', 'bob'], 'alice')).toBe(true)
    expect(isAuthorAllowed(['alice', 'bob'], 'bob')).toBe(true)
  })

  it('blocks an unlisted author', () => {
    expect(isAuthorAllowed(['alice'], 'bob')).toBe(false)
    expect(isAuthorAllowed(['alice', 'bob'], 'carol')).toBe(false)
  })

  it('is case-sensitive', () => {
    expect(isAuthorAllowed(['Alice'], 'alice')).toBe(false)
    expect(isAuthorAllowed(['alice'], 'Alice')).toBe(false)
  })
})
