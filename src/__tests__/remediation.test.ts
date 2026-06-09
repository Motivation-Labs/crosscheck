import { describe, it, expect } from 'vitest'
import { hintForError } from '../lib/remediation.js'

describe('hintForError', () => {
  it('returns codex login hint for codex auth errors', () => {
    const hint = hintForError('auth', 'codex auth failure during fix step — run: codex login')
    expect(hint).toContain('codex login')
    expect(hint).not.toContain('claude')
  })

  it('returns claude auth login hint for claude auth errors', () => {
    const hint = hintForError('auth', 'claude auth failure during conflict-resolve step — run: claude auth login')
    expect(hint).toContain('claude auth login')
    expect(hint).not.toContain('codex')
  })

  it('returns GITHUB_TOKEN hint for credential errors', () => {
    const hint = hintForError('auth', 'Bad credentials: GITHUB_TOKEN is invalid')
    expect(hint).toContain('GITHUB_TOKEN')
  })

  it('returns fallback auth hint when vendor is undetectable', () => {
    const hint = hintForError('auth', 'not logged in')
    expect(hint.length).toBeGreaterThan(0)
  })

  it('returns SSL-specific hint for LibreSSL errors', () => {
    const hint = hintForError('network', 'LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443')
    expect(hint).toContain('SSL')
    expect(hint).toContain('clone_protocol')
  })

  it('returns generic network hint for non-SSL network errors', () => {
    const hint = hintForError('network', 'fetch failed: ECONNREFUSED')
    expect(hint).toContain('github.com')
    expect(hint).not.toContain('SSL')
  })

  it('returns timeout config hint', () => {
    const hint = hintForError('timeout', 'timed out')
    expect(hint).toContain('timeout_sec')
  })

  it('returns rate limit hint', () => {
    expect(hintForError('rate_limit', '429 rate limit')).toContain('wait')
  })

  it('returns overloaded hint', () => {
    expect(hintForError('overloaded', '529 overloaded')).toContain('retry')
  })

  it('returns budget hint', () => {
    expect(hintForError('budget', 'budget exhausted')).toContain('per_review_budget_usd')
  })

  it('returns permission hint', () => {
    expect(hintForError('permission', '403 forbidden')).toContain('GITHUB_TOKEN')
  })

  it('returns empty string for subprocess and unknown', () => {
    expect(hintForError('subprocess', 'command failed')).toBe('')
    expect(hintForError('unknown', 'something weird')).toBe('')
  })
})
