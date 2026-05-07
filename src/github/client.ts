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

export async function registerRepoWebhook(
  owner: string,
  repo: string,
  webhookUrl: string,
  secret: string,
  token: string,
): Promise<number> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/hooks`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'web',
      active: true,
      events: ['pull_request'],
      config: { url: webhookUrl, content_type: 'json', secret },
    }),
  })
  if (!res.ok) {
    const err = await res.json() as { message?: string }
    throw new Error(`Failed to register repo webhook [${res.status}]: ${err.message ?? res.statusText}`)
  }
  const data = await res.json() as { id: number }
  return data.id
}

export async function deleteRepoWebhook(
  owner: string,
  repo: string,
  hookId: number,
  token: string,
): Promise<void> {
  await fetch(`https://api.github.com/repos/${owner}/${repo}/hooks/${hookId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  })
}

export async function registerOrgWebhook(
  org: string,
  webhookUrl: string,
  secret: string,
  token: string,
): Promise<number> {
  const res = await fetch(`https://api.github.com/orgs/${org}/hooks`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'web',
      active: true,
      events: ['pull_request'],
      config: { url: webhookUrl, content_type: 'json', secret },
    }),
  })
  if (!res.ok) {
    const err = await res.json() as { message?: string }
    throw new Error(`Failed to register org webhook [${res.status}]: ${err.message ?? res.statusText}`)
  }
  const data = await res.json() as { id: number }
  return data.id
}

export async function deleteOrgWebhook(
  org: string,
  hookId: number,
  token: string,
): Promise<void> {
  await fetch(`https://api.github.com/orgs/${org}/hooks/${hookId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  })
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
