// Classifies an error thrown out of runWorkflow into the shape needed to post
// a PR-visible failure comment. Returns null for non-reviewer errors so the
// caller (watch.ts catch) can skip posting on fix/conflict-resolve/setup
// failures — those have their own handling.
//
// Reviewer errors carry a `claude: ` or `codex: ` message prefix (set by
// runClaudeReview / runCodexReview when they wrap the underlying execa error)
// plus optional `timedOut`, `effectiveTimeoutMs`, `retryDelayMs`, `exitCode`,
// and `stderr` annotations.
import { isSubscriptionLimitError } from './smart-switch.js'
import type { ReviewFailedReason } from './comment-bodies.js'

interface ReviewerErrorAnnotations {
  timedOut?: boolean
  effectiveTimeoutMs?: number
  retryDelayMs?: number
  exitCode?: number
  stderr?: string
}

export interface ClassifiedReviewerError {
  reason: ReviewFailedReason
  // One-line user-facing description for the comment body.
  summary: string
  // Optional collapsible context block. Plain markdown.
  details?: string
}

export function classifyReviewerError(err: unknown): ClassifiedReviewerError | null {
  if (!(err instanceof Error)) return null
  if (!/^(claude|codex):\s/.test(err.message)) return null

  const ann = err as Error & ReviewerErrorAnnotations
  const vendor = err.message.startsWith('claude:') ? 'claude' : 'codex'

  if (ann.timedOut === true) {
    const timeoutSec = ann.effectiveTimeoutMs !== undefined
      ? Math.round(ann.effectiveTimeoutMs / 1000)
      : undefined
    const retryDelaySec = ann.retryDelayMs !== undefined
      ? Math.round(ann.retryDelayMs / 1000)
      : undefined
    const summary = timeoutSec !== undefined
      ? `${vendor} reviewer subprocess timed out after ${timeoutSec}s`
      : `${vendor} reviewer subprocess timed out`
    const detailLines = [
      `Vendor: \`${vendor}\``,
    ]
    if (timeoutSec !== undefined) {
      detailLines.push(`Configured timeout: ${timeoutSec}s`)
    }
    if (retryDelaySec !== undefined) {
      detailLines.push(`Retried once after a ${retryDelaySec}s wait — second attempt also timed out.`)
    }
    detailLines.push('', 'Consider splitting the PR or raising `vendor.<reviewer>.timeout_sec` in `crosscheck.config.yml`.')
    return { reason: 'timeout', summary, details: detailLines.join('\n') }
  }

  if (isSubscriptionLimitError(err)) {
    return {
      reason: 'usage_limit',
      summary: `${vendor} reviewer hit a usage / rate limit`,
      details: `Vendor: \`${vendor}\`\nError: ${stripVendorPrefix(err.message)}`,
    }
  }

  // Catch-all: auth failure, network, subprocess crash, garbled output, etc.
  const detailLines = [`Vendor: \`${vendor}\``]
  if (ann.exitCode !== undefined) detailLines.push(`Exit code: ${ann.exitCode}`)
  detailLines.push(`Error: ${stripVendorPrefix(err.message)}`)
  if (ann.stderr && ann.stderr.trim().length > 0) {
    const tail = ann.stderr.trim().split('\n').slice(-5).join('\n')
    detailLines.push('', '```', tail, '```')
  }
  return {
    reason: 'subprocess_error',
    summary: `${vendor} reviewer subprocess failed`,
    details: detailLines.join('\n'),
  }
}

function stripVendorPrefix(msg: string): string {
  return msg.replace(/^(claude|codex):\s*/, '')
}
