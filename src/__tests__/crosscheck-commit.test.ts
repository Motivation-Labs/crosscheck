import { describe, it, expect } from 'vitest'
import { isCrosscheckCommitMessage } from '../lib/crosscheck-commit.js'

describe('isCrosscheckCommitMessage', () => {
  it('matches crosscheck-authored commit prefixes', () => {
    expect(isCrosscheckCommitMessage('[crosscheck] fix: apply review edits')).toBe(true)
    expect(isCrosscheckCommitMessage('[crosscheck] resolve: resolve merge conflicts')).toBe(true)
  })

  it('does not match normal commits or body mentions', () => {
    expect(isCrosscheckCommitMessage('fix: mention [crosscheck] in the body')).toBe(false)
    expect(isCrosscheckCommitMessage('chore: update docs')).toBe(false)
  })
})
