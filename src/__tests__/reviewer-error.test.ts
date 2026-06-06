import { describe, it, expect } from 'vitest'
import { classifyReviewerError } from '../lib/reviewer-error.js'

function reviewerErr(
  message: string,
  ann: { timedOut?: boolean; effectiveTimeoutMs?: number; retryDelayMs?: number; exitCode?: number; stderr?: string } = {},
): Error {
  return Object.assign(new Error(message), ann)
}

describe('classifyReviewerError', () => {
  describe('non-reviewer errors → returns null', () => {
    it('returns null for plain strings / non-Error values', () => {
      expect(classifyReviewerError('boom')).toBeNull()
      expect(classifyReviewerError(undefined)).toBeNull()
      expect(classifyReviewerError({ message: 'claude: x' })).toBeNull()
    })

    it('returns null for Errors without a vendor message prefix', () => {
      expect(classifyReviewerError(new Error('git push failed'))).toBeNull()
      expect(classifyReviewerError(new Error('something blew up'))).toBeNull()
    })

    it('does not match prefixes embedded mid-message', () => {
      // The prefix must anchor at the start, otherwise normal log messages
      // mentioning "codex:" or "claude:" would be misclassified.
      expect(classifyReviewerError(new Error('upstream returned codex: timed out'))).toBeNull()
    })
  })

  describe('timeout', () => {
    it('classifies a tagged timeout with the effective cap rendered in seconds', () => {
      const err = reviewerErr('claude: timed out after 180s (retried once) — PR diff may be too large', {
        timedOut: true,
        effectiveTimeoutMs: 180_000,
        retryDelayMs: 120_000,
      })
      const out = classifyReviewerError(err)
      expect(out?.reason).toBe('timeout')
      expect(out?.summary).toContain('claude reviewer subprocess timed out after 180s')
      expect(out?.details).toContain('Vendor: `claude`')
      expect(out?.details).toContain('Configured timeout: 180s')
      expect(out?.details).toContain('120s wait')
      expect(out?.details).toContain('timeout_sec')
    })

    it('omits the timeout-seconds figure when the annotation is missing', () => {
      const err = reviewerErr('codex: timed out — PR diff may be too large', { timedOut: true })
      const out = classifyReviewerError(err)
      expect(out?.reason).toBe('timeout')
      expect(out?.summary).toBe('codex reviewer subprocess timed out')
      expect(out?.details).not.toMatch(/Configured timeout/)
    })

    it('rounds sub-second precision', () => {
      const err = reviewerErr('claude: timed out', { timedOut: true, effectiveTimeoutMs: 1_500 })
      expect(classifyReviewerError(err)?.summary).toContain('after 2s')
    })
  })

  describe('usage_limit', () => {
    it('classifies a subscription-limit error', () => {
      // isSubscriptionLimitError matches patterns like /rate.?limit|quota|429/i in the message
      const err = reviewerErr('claude: rate limit exceeded')
      const out = classifyReviewerError(err)
      expect(out?.reason).toBe('usage_limit')
      expect(out?.summary).toContain('claude reviewer hit a usage / rate limit')
      expect(out?.details).toContain('Vendor: `claude`')
      expect(out?.details).toContain('rate limit exceeded')  // vendor prefix stripped
      expect(out?.details).not.toContain('claude: rate limit')  // prefix gone
    })

    it('takes precedence over subprocess_error when message matches', () => {
      const err = reviewerErr('codex: usage limit reached for this period', { exitCode: 1 })
      expect(classifyReviewerError(err)?.reason).toBe('usage_limit')
    })
  })

  describe('subprocess_error', () => {
    it('catches non-timeout / non-limit failures with the generic reason', () => {
      const err = reviewerErr('claude: not logged in — run claude auth', { exitCode: 1, stderr: 'auth error\nnot logged in' })
      const out = classifyReviewerError(err)
      expect(out?.reason).toBe('subprocess_error')
      expect(out?.summary).toBe('claude reviewer subprocess failed')
      expect(out?.details).toContain('Vendor: `claude`')
      expect(out?.details).toContain('Exit code: 1')
      expect(out?.details).toContain('not logged in')
    })

    it('renders the stderr tail (last 5 lines) inside a fenced block when present', () => {
      const stderr = 'a\nb\nc\nd\ne\nf\ng'
      const err = reviewerErr('codex: command failed', { exitCode: 127, stderr })
      const details = classifyReviewerError(err)?.details ?? ''
      expect(details).toMatch(/```\nc\nd\ne\nf\ng\n```/)
      expect(details).not.toContain('a\nb\nc\nd\ne\nf\ng')  // not the full thing
    })

    it('skips the stderr fenced block when stderr is empty or blank', () => {
      const err = reviewerErr('claude: oops', { exitCode: 1, stderr: '   \n  ' })
      expect(classifyReviewerError(err)?.details ?? '').not.toContain('```')
    })
  })
})
