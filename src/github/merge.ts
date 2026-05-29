import type { Octokit } from 'octokit'

export type MergeMethod = 'merge' | 'squash' | 'rebase'

export interface MergePullRequestInput {
  owner: string
  repo: string
  pullNumber: number
  method: MergeMethod
  expectedHeadSha?: string
}

export async function mergePullRequest(
  octokit: Octokit,
  input: MergePullRequestInput,
): Promise<void> {
  await octokit.rest.pulls.merge({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.pullNumber,
    merge_method: input.method,
    sha: input.expectedHeadSha,
  })
}
