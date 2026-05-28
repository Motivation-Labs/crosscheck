import { describe, it, expect } from 'vitest'
import {
  buildFixAppliedCommentBody,
  buildConflictResolvedCommentBody,
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
