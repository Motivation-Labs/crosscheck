import { describe, it, expect } from 'vitest'
import {
  buildFixAppliedCommentBody,
  buildConflictResolvedCommentBody,
  buildRetriedReviewBanner,
  buildReviewFailedCommentBody,
} from '../lib/comment-bodies.js'

describe('buildFixAppliedCommentBody', () => {
  it('includes a 7-char sha link, applied count, and the fix_applied annotation tag', () => {
    const body = buildFixAppliedCommentBody({
      owner: 'codatta',
      repo: 'humanbased-monorepo',
      sha: 'abcdef0123456789',
      appliedCount: 3,
      reviewCommentId: 4555000111,
    })
    expect(body).toContain('[`abcdef0`](https://github.com/codatta/humanbased-monorepo/commit/abcdef0123456789)')
    expect(body).toContain('**3 changes applied**')
    expect(body).toContain('(#issuecomment-4555000111)')
    expect(body).toContain('<!-- crosscheck: fix_applied -->')
  })

  it('pluralizes change/changes correctly for 1 vs N', () => {
    const one = buildFixAppliedCommentBody({
      owner: 'o', repo: 'r', sha: 'a'.repeat(40), appliedCount: 1, reviewCommentId: 1,
    })
    const many = buildFixAppliedCommentBody({
      owner: 'o', repo: 'r', sha: 'a'.repeat(40), appliedCount: 5, reviewCommentId: 1,
    })
    expect(one).toContain('**1 change applied**')
    expect(many).toContain('**5 changes applied**')
  })

  it('omits the review backlink when no commentId is provided', () => {
    const body = buildFixAppliedCommentBody({
      owner: 'o', repo: 'r', sha: 'a'.repeat(40), appliedCount: 2,
    })
    expect(body).not.toContain('issuecomment-')
    expect(body).not.toContain('addressing the')
  })

  it('lists changed files under a "Files changed:" section', () => {
    const body = buildFixAppliedCommentBody({
      owner: 'o', repo: 'r', sha: 'a'.repeat(40), appliedCount: 2,
      changedFiles: ['src/auth.ts', 'src/utils/config.ts'],
    })
    expect(body).toContain('**Files changed:**')
    expect(body).toContain('- `src/auth.ts`')
    expect(body).toContain('- `src/utils/config.ts`')
  })

  it('truncates file list at 10 and shows a "...and N more" tail', () => {
    const files = Array.from({ length: 13 }, (_, i) => `src/file-${i}.ts`)
    const body = buildFixAppliedCommentBody({
      owner: 'o', repo: 'r', sha: 'a'.repeat(40), appliedCount: 13, changedFiles: files,
    })
    expect(body).toContain('- `src/file-9.ts`')
    expect(body).not.toContain('- `src/file-10.ts`')
    expect(body).toContain('- _...and 3 more_')
  })

  it('extracts bullet-point issues from the review comment body', () => {
    const reviewCommentBody = [
      '### Review',
      '',
      '- Missing null check in `auth.ts:42`',
      '- Unused import `React` in `App.tsx`',
      '1. Use `const` instead of `let` for config',
    ].join('\n')
    const body = buildFixAppliedCommentBody({
      owner: 'o', repo: 'r', sha: 'a'.repeat(40), appliedCount: 3,
      reviewCommentBody,
    })
    expect(body).toContain('**Issues addressed:**')
    expect(body).toContain('- Missing null check in `auth.ts:42`')
    expect(body).toContain('- Unused import `React` in `App.tsx`')
    expect(body).toContain('- Use `const` instead of `let` for config')
  })

  it('strips annotation tags before extracting issues', () => {
    const reviewCommentBody = '<!-- crosscheck: origin=claude -->\n- Real issue here'
    const body = buildFixAppliedCommentBody({
      owner: 'o', repo: 'r', sha: 'a'.repeat(40), appliedCount: 1,
      reviewCommentBody,
    })
    expect(body).toContain('- Real issue here')
    expect(body).not.toContain('origin=claude')
  })

  it('omits the issues section when the review body has no list items', () => {
    const body = buildFixAppliedCommentBody({
      owner: 'o', repo: 'r', sha: 'a'.repeat(40), appliedCount: 1,
      reviewCommentBody: 'Looks good overall. Minor style issues only.',
    })
    expect(body).not.toContain('**Issues addressed:**')
  })

  it('uses Claude Code attribution for claude vendor (default)', () => {
    const body = buildFixAppliedCommentBody({
      owner: 'o', repo: 'r', sha: 'a'.repeat(40), appliedCount: 1, vendor: 'claude',
    })
    expect(body).toContain('Fixed with [Claude Code]')
    expect(body).not.toContain('OpenAI Codex')
  })

  it('uses OpenAI Codex attribution for codex vendor', () => {
    const body = buildFixAppliedCommentBody({
      owner: 'o', repo: 'r', sha: 'a'.repeat(40), appliedCount: 1, vendor: 'codex',
    })
    expect(body).toContain('Fixed with [OpenAI Codex]')
    expect(body).not.toContain('Claude Code')
  })

  it('defaults to Claude Code attribution when vendor is omitted', () => {
    const body = buildFixAppliedCommentBody({
      owner: 'o', repo: 'r', sha: 'a'.repeat(40), appliedCount: 1,
    })
    expect(body).toContain('Fixed with [Claude Code]')
  })

  it('does not extract list items that appear inside fenced code blocks', () => {
    const reviewCommentBody = [
      '- Real issue: missing null check',
      '```diff',
      '- old_code()',
      '+ new_code()',
      '```',
      '- Another real issue',
    ].join('\n')
    const body = buildFixAppliedCommentBody({
      owner: 'o', repo: 'r', sha: 'a'.repeat(40), appliedCount: 2,
      reviewCommentBody,
    })
    expect(body).toContain('- Real issue: missing null check')
    expect(body).toContain('- Another real issue')
    expect(body).not.toContain('- old_code()')
    expect(body).not.toContain('+ new_code()')
  })
})

describe('buildConflictResolvedCommentBody', () => {
  it('lists each resolved file as a code-fenced bullet and includes the annotation tag', () => {
    const body = buildConflictResolvedCommentBody({
      owner: 'codatta',
      repo: 'humanbased-monorepo',
      sha: '0123456789abcdef',
      conflictCount: 2,
      files: ['src/a.ts', 'src/b.ts'],
    })
    expect(body).toContain('Resolved 2 conflicts in:')
    expect(body).toContain('- `src/a.ts`')
    expect(body).toContain('- `src/b.ts`')
    expect(body).toContain('[`0123456`]')
    expect(body).toContain('<!-- crosscheck: conflict_resolved -->')
  })

  it('pluralizes conflict/conflicts correctly', () => {
    const one = buildConflictResolvedCommentBody({
      owner: 'o', repo: 'r', sha: 'a'.repeat(40), conflictCount: 1, files: ['x.ts'],
    })
    expect(one).toContain('Resolved 1 conflict in:')
  })

  it('truncates the file list at 20 entries and shows a "...and N more" tail', () => {
    const files = Array.from({ length: 25 }, (_, i) => `src/file-${i}.ts`)
    const body = buildConflictResolvedCommentBody({
      owner: 'o', repo: 'r', sha: 'a'.repeat(40), conflictCount: 25, files,
    })
    expect(body).toContain('- `src/file-0.ts`')
    expect(body).toContain('- `src/file-19.ts`')
    expect(body).not.toContain('- `src/file-20.ts`')
    expect(body).toContain('- _...and 5 more_')
  })

  it('omits the truncation tail when the file list fits', () => {
    const body = buildConflictResolvedCommentBody({
      owner: 'o', repo: 'r', sha: 'a'.repeat(40), conflictCount: 3,
      files: ['a.ts', 'b.ts', 'c.ts'],
    })
    expect(body).not.toContain('...and')
    expect(body).not.toContain('more_')
  })
})

describe('buildRetriedReviewBanner', () => {
  it('renders rounded seconds for the timeout and the retry delay', () => {
    const banner = buildRetriedReviewBanner(180_000, 120_000)
    expect(banner).toContain('⏱ **Retried**')
    expect(banner).toContain('timed out at 180s')
    expect(banner).toContain('120s wait')
    expect(banner.startsWith('> ')).toBe(true)
  })

  it('rounds sub-second precision', () => {
    expect(buildRetriedReviewBanner(1_500, 2_400)).toContain('timed out at 2s')
  })

  it('points the reader at the timeout_sec knob for repeat occurrences', () => {
    const banner = buildRetriedReviewBanner(180_000, 120_000)
    expect(banner).toContain('`timeout_sec`')
  })
})

describe('buildReviewFailedCommentBody', () => {
  const PR_URL = 'https://github.com/o/r/pull/42'

  it('renders the timeout reason with summary, retry hint, and the non-review marker', () => {
    const body = buildReviewFailedCommentBody({
      prUrl: PR_URL,
      reason: 'timeout',
      summary: 'claude reviewer subprocess timed out after 180s',
      details: 'Vendor: `claude`\nConfigured timeout: 180s',
    })
    expect(body).toContain('### ⏱️ Review failed — timed out')
    expect(body).toContain('**Reason**: claude reviewer subprocess timed out after 180s')
    expect(body).toContain('crosscheck run https://github.com/o/r/pull/42')
    expect(body).toContain('<!-- crosscheck: review_failed -->')
    // Distinct from a review annotation so Phase 1 detection ignores it.
    expect(body).not.toContain('origin=')
  })

  it('uses the usage_limit title and renders the summary verbatim', () => {
    const body = buildReviewFailedCommentBody({
      prUrl: PR_URL,
      reason: 'usage_limit',
      summary: 'claude reviewer hit a usage / rate limit',
    })
    expect(body).toContain('### 🚫 Review failed — reviewer hit usage limit')
    expect(body).toContain('**Reason**: claude reviewer hit a usage / rate limit')
  })

  it('uses the generic subprocess_error title for unspecified failures', () => {
    const body = buildReviewFailedCommentBody({
      prUrl: PR_URL,
      reason: 'subprocess_error',
      summary: 'codex reviewer subprocess failed',
    })
    expect(body).toContain('### ❌ Review failed')
    expect(body).not.toContain('timed out')
  })

  it('wraps non-empty details in a collapsible <details> block', () => {
    const body = buildReviewFailedCommentBody({
      prUrl: PR_URL,
      reason: 'timeout',
      summary: 's',
      details: 'Vendor: `claude`\nConfigured timeout: 180s',
    })
    expect(body).toContain('<details>')
    expect(body).toContain('<summary>Details</summary>')
    expect(body).toContain('Vendor: `claude`')
    expect(body).toContain('</details>')
  })

  it('omits the <details> block entirely when details is missing or blank', () => {
    const noDetails = buildReviewFailedCommentBody({
      prUrl: PR_URL, reason: 'subprocess_error', summary: 's',
    })
    const blank = buildReviewFailedCommentBody({
      prUrl: PR_URL, reason: 'subprocess_error', summary: 's', details: '   \n  ',
    })
    expect(noDetails).not.toContain('<details>')
    expect(blank).not.toContain('<details>')
  })
})

