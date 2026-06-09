import { describe, it, expect } from 'vitest'
import { classifyError } from '../lib/logger.js'

// Regression coverage for #191: transient model-API errors (429 / 529 / budget)
// were misclassified as `auth` because the broad auth pattern (which matches the
// bare word "token") ran before the more specific transient checks.
describe('classifyError — transient errors must not be mislabeled as auth', () => {
  it('classifies 429 rate-limit as rate_limit even when the body mentions a token', () => {
    expect(classifyError('Claude api_error_status: 429 rate limit — check token usage')).toBe('rate_limit')
  })

  it('classifies 529 overloaded as overloaded', () => {
    expect(classifyError('API Error: 529 Overloaded. Please try again in a moment.')).toBe('overloaded')
  })

  it('classifies budget exhaustion as budget', () => {
    expect(classifyError('error_max_budget_usd: Reached maximum budget ($2)')).toBe('budget')
  })

  it('does not match 429/529 digits embedded in durations or counts', () => {
    // Without word boundaries, "5290ms" matched /529/ and a timeout read as `overloaded`.
    expect(classifyError('Request timed out after 5290ms')).toBe('timeout')
    expect(classifyError('operation timed out after 4290ms')).toBe('timeout')
    expect(classifyError('processed 1529 records then exited with code 1')).toBe('subprocess')
  })

  it('still classifies genuine credential failures as auth', () => {
    expect(classifyError('Bad credentials (401): GITHUB_TOKEN is invalid')).toBe('auth')
    expect(classifyError('You are not logged in')).toBe('auth')
  })

  it('still classifies permission, network, timeout, and subprocess failures', () => {
    expect(classifyError('403 forbidden: insufficient scope (write:org)')).toBe('permission')
    expect(classifyError('fetch failed: ECONNREFUSED 140.82.0.1:443')).toBe('network')
    expect(classifyError('Request timed out after 180000ms')).toBe('timeout')
    expect(classifyError('Command failed: exited with code 1')).toBe('subprocess')
  })

  it('falls back to unknown for unrecognized messages', () => {
    expect(classifyError('something nobody anticipated')).toBe('unknown')
  })
})

describe('classifyError — SSL and auth failure patterns from real failures', () => {
  it('classifies LibreSSL SSL_ERROR_SYSCALL as network', () => {
    expect(classifyError(
      'LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443',
    )).toBe('network')
  })

  it('classifies codex auth failure message as auth', () => {
    expect(classifyError('codex auth failure during fix step — run: codex login')).toBe('auth')
  })

  it('classifies claude auth failure message as auth', () => {
    expect(classifyError('claude auth failure during conflict-resolve step — run: claude auth login')).toBe('auth')
  })

  it('classifies generic auth failure text as auth', () => {
    expect(classifyError('auth failure: session expired')).toBe('auth')
  })
})
