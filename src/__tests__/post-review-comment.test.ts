import { describe, it, expect, vi } from 'vitest'
import { postReviewComment } from '../github/client.js'

function makeOctokit() {
  const createComment = vi.fn().mockResolvedValue({ data: { id: 123 } })
  return {
    octokit: {
      rest: {
        issues: { createComment },
      },
    } as never,
    createComment,
  }
}

describe('postReviewComment', () => {
  it('emits a v2 review annotation even when verdict parsing failed', async () => {
    const { octokit, createComment } = makeOctokit()

    await postReviewComment(
      octokit,
      'owner',
      'repo',
      42,
      'Review body',
      'codex',
      {},
      'claude',
      null,
    )

    expect(createComment).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining(
        '<!-- crosscheck: origin=claude reviewer=codex model=default type=review round=1 verdict=UNKNOWN service=crosscheck -->',
      ),
    }))
  })
})
