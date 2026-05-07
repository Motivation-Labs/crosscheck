import { Octokit } from 'octokit'
import { createHmac, timingSafeEqual } from 'crypto'

export function createGithubClient(token: string) {
  return new Octokit({ auth: token })
}

export function verifyWebhookSignature(payload: string, signature: string, secret: string): boolean {
  const expected = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  } catch {
    return false
  }
}

export async function getPRDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<string> {
  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
    mediaType: { format: 'diff' },
  })
  return data as unknown as string
}

export async function postReviewComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  body: string,
  reviewer: string,
): Promise<void> {
  const header = `### Code Review by ${reviewer === 'claude' ? '🤖 Claude Code' : '⚡ Codex'}\n\n`
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: pullNumber,
    body: header + body,
  })
}
