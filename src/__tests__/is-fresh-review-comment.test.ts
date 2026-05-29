import { describe, it, expect } from 'vitest'
import { isFreshReviewComment } from '../github/client.js'

describe('isFreshReviewComment', () => {
  it('returns true for a current review annotation', () => {
    expect(isFreshReviewComment(
      '### Code Review by ⚡ Codex\n\nbody\n\n<!-- crosscheck: origin=claude reviewer=codex verdict=BLOCK type=review -->',
    )).toBe(true)
  })

  it('returns true for a v2 review annotation with model, round, and service', () => {
    expect(isFreshReviewComment(
      '### Code Review by ⚡ Codex\n\nbody\n\n<!-- crosscheck: origin=claude reviewer=codex model=gpt-5 type=review round=2 verdict=BLOCK service=crosscheck -->',
    )).toBe(true)
  })

  it('returns false for a recheck annotation', () => {
    expect(isFreshReviewComment(
      '> Recheck of [original review](#issuecomment-1)\n\n### Code Review by ⚡ Codex\n\nbody\n\n<!-- crosscheck: origin=claude reviewer=codex verdict=NEEDS_WORK type=recheck -->',
    )).toBe(false)
  })

  it('returns true for a verdict-less review annotation from a null-verdict run', () => {
    expect(isFreshReviewComment(
      '### Code Review by ⚡ Codex\n\nbody\n\n<!-- crosscheck: origin=claude reviewer=codex type=review -->',
    )).toBe(true)
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

  // Guards Codex's PR #149 [P2]: 2026-05-18 annotated reviews (between commits
  // 9a0c324 and 36c915d) carry `<!-- crosscheck: origin reviewer verdict -->`
  // without a `type=` field. They must still classify as fresh reviews so
  // recheck backlink discovery survives the upgrade.
  it('returns true for a pre-type-era annotated review (annotation without type=, has reviewer=, has header)', () => {
    expect(isFreshReviewComment(
      '### Code Review by ⚡ Codex\n\nbody\n\n<!-- crosscheck: origin=claude reviewer=codex verdict=BLOCK -->',
    )).toBe(true)
  })

  it('returns false for a pre-type-era annotated recheck (no type=, has reviewer=, "> Recheck of" prefix)', () => {
    expect(isFreshReviewComment(
      '> Recheck of [original review](#issuecomment-1)\n\n### Code Review by ⚡ Codex\n\nbody\n\n<!-- crosscheck: origin=claude reviewer=codex verdict=NEEDS_WORK -->',
    )).toBe(false)
  })

  it('does not treat parser defaults alone as proof of a fresh review', () => {
    expect(isFreshReviewComment(
      'Status note without the review header.\n\n<!-- crosscheck: origin=claude reviewer=codex verdict=BLOCK -->',
    )).toBe(false)
  })

  it('returns false for an unrelated human comment with neither annotation nor header', () => {
    expect(isFreshReviewComment('LGTM, merging now.')).toBe(false)
  })

  // Guards Codex's PR #149 second-recheck [P2]: review bodies often quote
  // other crosscheck marker names as part of the finding text (Codex itself
  // referenced `<!-- crosscheck: fix_applied -->` while reviewing this PR).
  // Classification must read the FOOTER annotation appended by
  // postReviewComment, not the first occurrence in the body.
  it('classifies by the footer annotation, ignoring earlier quoted markers in the body', () => {
    const body = '### Code Review by ⚡ Codex\n\n'
      + 'The finding references `<!-- crosscheck: fix_applied -->` as an example of '
      + 'a non-review annotation.\n\n'
      + '<!-- crosscheck: origin=claude reviewer=codex verdict=BLOCK type=review -->'
    expect(isFreshReviewComment(body)).toBe(true)
  })

  it('classifies as recheck when the footer says recheck even if an earlier quoted annotation looks like a review', () => {
    const body = '> Recheck of [original review](#issuecomment-1)\n\n'
      + '### Code Review by ⚡ Codex\n\n'
      + 'Quote of the prior review annotation: `<!-- crosscheck: origin=claude reviewer=codex verdict=BLOCK type=review -->`\n\n'
      + '<!-- crosscheck: origin=claude reviewer=codex verdict=NEEDS_WORK type=recheck -->'
    expect(isFreshReviewComment(body)).toBe(false)
  })
})
