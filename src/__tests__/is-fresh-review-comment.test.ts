import { describe, it, expect } from 'vitest'
import { isFreshReviewComment } from '../github/client.js'

describe('isFreshReviewComment', () => {
  it('returns true for a current review annotation', () => {
    expect(isFreshReviewComment(
      '### Code Review by ⚡ Codex\n\nbody\n\n<!-- crosscheck: origin=claude reviewer=codex verdict=BLOCK type=review -->',
    )).toBe(true)
  })

  it('returns false for a recheck annotation', () => {
    expect(isFreshReviewComment(
      '> Recheck of [original review](#issuecomment-1)\n\n### Code Review by ⚡ Codex\n\nbody\n\n<!-- crosscheck: origin=claude reviewer=codex verdict=NEEDS_WORK type=recheck -->',
    )).toBe(false)
  })

  it('returns false for a fix_failed annotation', () => {
    expect(isFreshReviewComment(
      '⚠️ **Auto-fix failed**\n\nblah\n\n<!-- crosscheck: fix_failed -->',
    )).toBe(false)
  })

  // Guards the regression Codex flagged on PR #149: the summary cards emitted by
  // commit-mode fix and conflict-resolve must NOT classify as fresh reviews, or
  // subsequent rechecks will backlink to the summary instead of the actual review.
  it('returns false for a fix_applied summary annotation', () => {
    expect(isFreshReviewComment(
      '### ✅ Auto-fix applied\n\nPushed [`abc1234`](...)\n\n<!-- crosscheck: fix_applied -->',
    )).toBe(false)
  })

  it('returns false for a conflict_resolved summary annotation', () => {
    expect(isFreshReviewComment(
      '### 🔀 Conflicts resolved\n\nResolved 2 conflicts\n\n<!-- crosscheck: conflict_resolved -->',
    )).toBe(false)
  })

  it('returns false for a no_diff_change notice', () => {
    expect(isFreshReviewComment(
      '✓ No diff change since the last review (was `abc1234`, now `def5678`). Skipping re-review.\n\n<!-- crosscheck: no_diff_change prev_sha=abc sha=def -->',
    )).toBe(false)
  })

  // Defensive: the annotation is the source of truth. Even when the body happens
  // to contain the legacy "### Code Review by" header, a non-review annotation
  // wins. This guards against any future bare annotation accidentally falling
  // through to the legacy header check.
  it('rejects a summary card even when the body coincidentally contains the legacy review header', () => {
    expect(isFreshReviewComment(
      '### ✅ Auto-fix applied\n\nFix references "### Code Review by ⚡ Codex" in passing.\n\n<!-- crosscheck: fix_applied -->',
    )).toBe(false)
  })

  it('returns true for a legacy (pre-annotation) review with the header and no recheck prefix', () => {
    expect(isFreshReviewComment(
      '### Code Review by ⚡ Codex\n\nbody, no annotation',
    )).toBe(true)
  })

  it('returns false for a legacy recheck identified by the "> Recheck of" prefix', () => {
    expect(isFreshReviewComment(
      '> Recheck of [original review](#issuecomment-1)\n\n### Code Review by ⚡ Codex\n\nbody, no annotation',
    )).toBe(false)
  })

  it('returns false for an unrelated human comment with neither annotation nor header', () => {
    expect(isFreshReviewComment('LGTM, merging now.')).toBe(false)
  })
})
