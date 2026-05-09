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

export async function listUserOrgs(token: string): Promise<string[]> {
  const results: string[] = []
  let page = 1
  while (true) {
    const res = await fetch(
      `https://api.github.com/user/memberships/orgs?state=active&per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
    )
    if (!res.ok) break
    const data = await res.json() as Array<{ organization: { login: string } }>
    if (data.length === 0) break
    for (const m of data) results.push(m.organization.login)
    if (data.length < 100) break
    page++
  }
  return results
}

export async function checkRepoAccessible(owner: string, repo: string, token: string): Promise<boolean> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  })
  return res.ok
}

export async function listUserRepos(
  username: string,
  token: string,
  isSelf = false,  // true → use /user/repos to include private repos for the authenticated user
): Promise<Array<{ owner: string; name: string }>> {
  const results: Array<{ owner: string; name: string }> = []
  let page = 1
  while (true) {
    const url = isSelf
      ? `https://api.github.com/user/repos?affiliation=owner&visibility=all&per_page=100&page=${page}`
      : `https://api.github.com/users/${username}/repos?per_page=100&page=${page}&type=owner`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } })
    if (!res.ok) break
    const data = await res.json() as Array<{ name: string; owner: { login: string }; archived: boolean }>
    if (data.length === 0) break
    for (const repo of data) {
      if (!repo.archived && repo.owner.login === username) results.push({ owner: repo.owner.login, name: repo.name })
    }
    if (data.length < 100) break
    page++
  }
  return results
}

export async function listOrgRepos(
  org: string,
  token: string,
): Promise<Array<{ owner: string; name: string }>> {
  const results: Array<{ owner: string; name: string }> = []
  let page = 1
  while (true) {
    const res = await fetch(
      `https://api.github.com/orgs/${org}/repos?per_page=100&page=${page}&type=all`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
    )
    if (!res.ok) break
    const data = await res.json() as Array<{ name: string; archived: boolean }>
    if (data.length === 0) break
    for (const repo of data) {
      if (!repo.archived) results.push({ owner: org, name: repo.name })
    }
    if (data.length < 100) break
    page++
  }
  return results
}

export interface OpenPR {
  number: number
  title: string
  author: string
  headSha: string
  headRef: string
  baseRef: string
  body: string | null
  createdAt: string
}

export async function listOpenPRs(
  owner: string,
  repo: string,
  token: string,
): Promise<OpenPR[]> {
  const results: OpenPR[] = []
  let page = 1
  while (true) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
    )
    if (!res.ok) break
    const data = await res.json() as Array<{
      number: number
      title: string
      user: { login: string }
      head: { sha: string; ref: string }
      base: { ref: string }
      body: string | null
      created_at: string
    }>
    if (data.length === 0) break
    for (const pr of data) {
      results.push({
        number: pr.number,
        title: pr.title,
        author: pr.user.login,
        headSha: pr.head.sha,
        headRef: pr.head.ref,
        baseRef: pr.base.ref,
        body: pr.body,
        createdAt: pr.created_at,
      })
    }
    if (data.length < 100) break
    page++
  }
  return results
}

// Returns true if any comment on the PR contains '[crosscheck]' — meaning it
// has already been reviewed by this tool.
export async function prHasCrossCheckComment(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<boolean> {
  let page = 1
  while (true) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
    )
    if (!res.ok) return false
    const data = await res.json() as Array<{ body: string }>
    if (data.length === 0) break
    for (const comment of data) {
      if (comment.body.includes('[crosscheck]')) return true
    }
    if (data.length < 100) break
    page++
  }
  return false
}

export async function getPRCommits(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<string[]> {
  const results: string[] = []
  let page = 1
  while (true) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/commits?per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
    )
    if (!res.ok) break
    const data = await res.json() as Array<{ commit: { message: string } }>
    if (data.length === 0) break
    for (const c of data) results.push(c.commit.message)
    if (data.length < 100) break
    page++
  }
  return results
}

export async function findOrgWebhook(org: string, url: string, token: string): Promise<number | null> {
  const res = await fetch(`https://api.github.com/orgs/${org}/hooks?per_page=100`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  })
  if (!res.ok) return null
  const hooks = await res.json() as Array<{ id: number; config: { url: string } }>
  return hooks.find(h => h.config.url === url)?.id ?? null
}

export async function findRepoWebhook(owner: string, repo: string, url: string, token: string): Promise<number | null> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/hooks?per_page=100`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  })
  if (!res.ok) return null
  const hooks = await res.json() as Array<{ id: number; config: { url: string } }>
  return hooks.find(h => h.config.url === url)?.id ?? null
}

export async function postReviewComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  body: string,
  reviewer: string,
): Promise<void> {
  const isClaude = reviewer === 'claude'
  const header = `### Code Review by ${isClaude ? '🤖 Claude Code' : '⚡ Codex'}\n\n`
  const footer = isClaude
    ? '\n\n---\n_Reviewed with [Claude Code](https://claude.ai/code)_'
    : '\n\n---\n_Reviewed with [OpenAI Codex](https://openai.com/codex)_'
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: pullNumber,
    body: header + body + footer,
  })
}
