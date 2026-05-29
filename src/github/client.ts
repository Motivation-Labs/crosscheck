import { Octokit } from 'octokit'
import { createHmac, timingSafeEqual } from 'crypto'
import { buildAnnotation, parseAnnotation, parseAnnotationFields, type CrosscheckStepType } from '../lib/annotation.js'
import { modelDisplayName } from '../lib/review-models.js'

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
): Promise<Array<{ owner: string; name: string; pushedAt: Date | null }>> {
  const results: Array<{ owner: string; name: string; pushedAt: Date | null }> = []
  let page = 1
  while (true) {
    const res = await fetch(
      `https://api.github.com/orgs/${org}/repos?per_page=100&page=${page}&sort=pushed&type=all`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
    )
    if (!res.ok) {
      if (page === 1) throw new Error(`Failed to list org repos [${res.status}]: ${res.statusText}`)
      break
    }
    const data = await res.json() as Array<{ name: string; archived: boolean; pushed_at: string | null }>
    if (data.length === 0) break
    for (const repo of data) {
      if (!repo.archived) {
        results.push({ owner: org, name: repo.name, pushedAt: repo.pushed_at ? new Date(repo.pushed_at) : null })
      }
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
  headRepo: string | null   // null for deleted-fork PRs; use as head.repo.full_name
  baseRef: string
  body: string | null
  createdAt: string
  updatedAt: string
  url?: string
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
    if (!res.ok) {
      if (page === 1) throw new Error(`Failed to list open PRs [${res.status}]: ${res.statusText}`)
      break
    }
    const data = await res.json() as Array<{
      number: number
      title: string
      user: { login: string } | null
      head: { sha: string; ref: string; repo: { full_name: string } | null }
      base: { ref: string }
      body: string | null
      created_at: string
      updated_at: string
      html_url: string
    }>
    if (data.length === 0) break
    for (const pr of data) {
      results.push({
        number: pr.number,
        title: pr.title,
        author: pr.user?.login ?? 'ghost',
        headSha: pr.head.sha,
        headRef: pr.head.ref,
        headRepo: pr.head.repo?.full_name ?? null,
        baseRef: pr.base.ref,
        body: pr.body,
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        url: pr.html_url,
      })
    }
    if (data.length < 100) break
    page++
  }
  return results
}

export interface PRComment {
  id: number
  body: string
  createdAt: string
  updatedAt: string
}

export async function listPRComments(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<PRComment[]> {
  const results: PRComment[] = []
  let page = 1
  while (true) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
    )
    if (!res.ok) throw new Error(`Failed to list PR comments [${res.status}]: ${res.statusText}`)
    const data = await res.json() as Array<{ id: number; body: string; created_at: string; updated_at: string }>
    if (data.length === 0) break
    for (const comment of data) {
      results.push({
        id: comment.id,
        body: comment.body,
        createdAt: comment.created_at,
        updatedAt: comment.updated_at,
      })
    }
    if (data.length < 100) break
    page++
  }
  return results
}

export interface PRCommitDetail {
  sha: string
  committedAt: string
}

export async function listPRCommitsDetailed(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<PRCommitDetail[]> {
  const results: PRCommitDetail[] = []
  let page = 1
  while (true) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/commits?per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
    )
    if (!res.ok) throw new Error(`Failed to list PR commits [${res.status}]: ${res.statusText}`)
    const data = await res.json() as Array<{ sha: string; commit: { committer: { date: string | null }; author: { date: string | null } } }>
    if (data.length === 0) break
    for (const commit of data) {
      const committedAt = commit.commit.committer.date ?? commit.commit.author.date
      if (committedAt) results.push({ sha: commit.sha, committedAt })
    }
    if (data.length < 100) break
    page++
  }
  return results
}

export interface CommitStatusDetail {
  context: string
  state: string
  updatedAt: string
}

export async function listCommitStatuses(
  owner: string,
  repo: string,
  sha: string,
  token: string,
): Promise<CommitStatusDetail[]> {
  const results: CommitStatusDetail[] = []
  let page = 1
  while (true) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits/${sha}/statuses?per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
    )
    if (!res.ok) {
      if (page === 1) throw new Error(`Failed to list commit statuses [${res.status}]: ${res.statusText}`)
      break
    }
    const data = await res.json() as Array<{ context: string; state: string; updated_at: string }>
    if (data.length === 0) break
    for (const status of data) {
      results.push({ context: status.context, state: status.state, updatedAt: status.updated_at })
    }
    if (data.length < 100) break
    page++
  }
  return results
}

export interface GitHubCommentActivity {
  body: string
  createdAt: string
  updatedAt?: string
}

export interface GitHubCommitActivity {
  sha: string
  committedAt: string
}

export interface GitHubTimestampActivity {
  state?: string
  name?: string
  conclusion?: string | null
  status?: string | null
  updatedAt: string
}

export async function listIssueComments(
  owner: string,
  repo: string,
  issueNumber: number,
  token: string,
): Promise<GitHubCommentActivity[]> {
  const results: GitHubCommentActivity[] = []
  let page = 1
  while (true) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
    )
    if (!res.ok) {
      if (page === 1) throw new Error(`Failed to list issue comments [${res.status}]: ${res.statusText}`)
      break
    }
    const data = await res.json() as Array<{ body: string; created_at: string; updated_at: string }>
    if (data.length === 0) break
    for (const comment of data) {
      results.push({ body: comment.body, createdAt: comment.created_at, updatedAt: comment.updated_at })
    }
    if (data.length < 100) break
    page++
  }
  return results
}

export async function listPRReviewComments(
  owner: string,
  repo: string,
  pullNumber: number,
  token: string,
): Promise<GitHubCommentActivity[]> {
  const results: GitHubCommentActivity[] = []
  let page = 1
  while (true) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/comments?per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
    )
    if (!res.ok) {
      if (page === 1) throw new Error(`Failed to list PR review comments [${res.status}]: ${res.statusText}`)
      break
    }
    const data = await res.json() as Array<{ body: string; created_at: string; updated_at: string }>
    if (data.length === 0) break
    for (const comment of data) {
      results.push({ body: comment.body, createdAt: comment.created_at, updatedAt: comment.updated_at })
    }
    if (data.length < 100) break
    page++
  }
  return results
}

export async function listPRCommitActivity(
  owner: string,
  repo: string,
  pullNumber: number,
  token: string,
): Promise<GitHubCommitActivity[]> {
  const results: GitHubCommitActivity[] = []
  let page = 1
  while (true) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/commits?per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
    )
    if (!res.ok) {
      if (page === 1) throw new Error(`Failed to list PR commit activity [${res.status}]: ${res.statusText}`)
      break
    }
    const data = await res.json() as Array<{
      sha: string
      commit: { author: { date: string | null } | null; committer: { date: string | null } | null }
    }>
    if (data.length === 0) break
    for (const commit of data) {
      const committedAt = commit.commit.committer?.date ?? commit.commit.author?.date
      if (committedAt) results.push({ sha: commit.sha, committedAt })
    }
    if (data.length < 100) break
    page++
  }
  return results
}

export async function listCheckRuns(
  owner: string,
  repo: string,
  ref: string,
  token: string,
): Promise<GitHubTimestampActivity[]> {
  const results: GitHubTimestampActivity[] = []
  let page = 1
  while (true) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits/${ref}/check-runs?per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
    )
    if (!res.ok) break
    const data = await res.json() as {
      check_runs: Array<{ name: string; status: string; conclusion: string | null; completed_at: string | null; started_at: string | null }>
    }
    if (data.check_runs.length === 0) break
    for (const run of data.check_runs) {
      const updatedAt = run.completed_at ?? run.started_at
      if (updatedAt) results.push({ name: run.name, status: run.status, conclusion: run.conclusion, updatedAt })
    }
    if (data.check_runs.length < 100) break
    page++
  }
  return results
}

export async function listTimelineEvents(
  owner: string,
  repo: string,
  issueNumber: number,
  token: string,
): Promise<GitHubTimestampActivity[]> {
  const results: GitHubTimestampActivity[] = []
  let page = 1
  while (true) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/timeline?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
        },
      },
    )
    if (!res.ok) break
    const data = await res.json() as Array<{ event?: string; created_at?: string }>
    if (data.length === 0) break
    for (const event of data) {
      if (event.created_at) results.push({ name: event.event, updatedAt: event.created_at })
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

// True iff `body` is a fresh review comment that a recheck should link back to.
// Classification cascade:
//   1. Contract annotation parsed by annotation.ts with explicit type=review
//      → review. Other explicit types are not reviews.
//   2. Legacy annotations without type= fall through to the header check so
//      pre-type rechecks are still excluded by the "> Recheck of" prefix.
//   3. Bare summary/notification markers (`fix_failed`, `fix_applied`,
//      `conflict_resolved`, `no_diff_change`, future bare markers) are not reviews.
//   4. No annotation → legacy pre-annotation comment. Identify reviews by the
//      canonical "### Code Review by" header, exclude rechecks by the
//      "> Recheck of" prefix.
export function isFreshReviewComment(body: string): boolean {
  const fields = parseAnnotationFields(body)
  const parsed = parseAnnotation(body)
  if (parsed && fields?.has('type')) {
    // Explicit type= field present — trust it directly.
    return parsed.type === 'review'
  }
  if (parsed && !fields?.has('type')) {
    // Pre-type-era annotation: type was defaulted to 'review', not stated.
    // Fall through to the header/prefix check so legacy rechecks are excluded.
  } else if (fields && !parsed) {
    // Has an annotation tag but no origin+reviewer — bare summary marker.
    return false
  }
  // No annotation (or pre-type fallthrough): use header + recheck-prefix heuristic.
  return body.includes('### Code Review by') && !body.startsWith('> Recheck of')
}

// Returns the GitHub comment ID of the most recent crosscheck REVIEW comment.
// Used by recheck steps to link back to the original review that raised issues.
// Classification is delegated to `isFreshReviewComment` — annotation is the
// source of truth, with a header-based fallback for pre-annotation comments.
export async function getLastCrossCheckCommentId(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<number | undefined> {
  let page = 1
  let lastId: number | undefined
  while (true) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
    )
    if (!res.ok) break
    const data = await res.json() as Array<{ id: number; body: string }>
    if (data.length === 0) break
    for (const comment of data) {
      if (isFreshReviewComment(comment.body)) {
        lastId = comment.id
      }
    }
    if (data.length < 100) break
    page++
  }
  return lastId
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

export async function getCommitMessage(
  owner: string,
  repo: string,
  sha: string,
  token: string,
): Promise<string | null> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/commits/${sha}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
  )
  if (!res.ok) return null
  const data = await res.json() as { commit?: { message?: string } }
  return data.commit?.message ?? null
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

// ── Repo activity for onboarding ────────────────────────────────────────────

export interface RepoActivity {
  tier: 1 | 2 | 3  // 1=new(<7d), 2=active(pushed<90d), 3=inactive
  fullName: string  // "owner/repo"
  pushedAt: Date
  createdAt: Date
}

export async function fetchActiveRepos(login: string, token: string): Promise<RepoActivity[]> {
  const results: RepoActivity[] = []
  const now = Date.now()
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000
  let page = 1

  while (true) {
    const res = await fetch(
      `https://api.github.com/user/repos?affiliation=owner&visibility=all&sort=pushed&per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
    )
    if (!res.ok) break
    const data = await res.json() as Array<{
      name: string; owner: { login: string }; archived: boolean
      pushed_at: string | null; created_at: string
    }>
    if (data.length === 0) break

    for (const r of data) {
      if (r.archived || r.owner.login !== login) continue
      const createdAt = new Date(r.created_at)
      const pushedAt = r.pushed_at ? new Date(r.pushed_at) : createdAt
      const createdAgo = now - createdAt.getTime()
      const pushedAgo = now - pushedAt.getTime()
      const tier: 1 | 2 | 3 = createdAgo < sevenDaysMs ? 1 : pushedAgo < ninetyDaysMs ? 2 : 3
      results.push({ tier, fullName: `${login}/${r.name}`, pushedAt, createdAt })
    }

    if (data.length < 100) break
    page++
  }

  // Tier 1 first (newest created), within each tier sort by pushedAt desc
  results.sort((a, b) => a.tier !== b.tier ? a.tier - b.tier : b.pushedAt.getTime() - a.pushedAt.getTime())
  return results
}

export interface BrandOptions {
  service_name?: string
  comment_header?: string
  comment_footer?: string
  reviewer_attribution?: string
}

export interface ReviewCommentBodyInput {
  body: string
  reviewer: string
  brand?: BrandOptions
  origin?: string
  verdict?: string | null
  replyToCommentId?: number
  isRecheck?: boolean
  model?: string
  stepType?: CrosscheckStepType
  round?: number
}

export function buildReviewCommentBody(input: ReviewCommentBodyInput): string {
  const reviewer = input.reviewer
  const brand = input.brand ?? {}
  const model = input.model ?? 'default'
  const round = input.round ?? 1
  const stepType = input.stepType ?? (input.isRecheck ? 'recheck' : 'review')
  const serviceName = brand.service_name || 'crosscheck'
  const isClaude = reviewer === 'claude'
  const vendorLabel = isClaude ? '🤖 Claude Code' : '⚡ Codex'
  const modelDisplay = modelDisplayName(model)
  const serviceSegment = serviceName !== 'crosscheck' ? ` · ${serviceName}` : ''
  const modelSegment = modelDisplay ? ` · ${modelDisplay}` : ''
  const header = `### ${stepVerb(stepType)} by ${vendorLabel}${modelSegment}${serviceSegment}\n\n`

  const defaultAttribution = isClaude
    ? '_Reviewed with [Claude Code](https://claude.ai/code)_'
    : '_Reviewed with [OpenAI Codex](https://openai.com/codex)_'
  const attribution = brand.reviewer_attribution || defaultAttribution
  const footer = `\n\n---\n${attribution}`

  const customHeader = brand.comment_header ? `${brand.comment_header}\n\n` : ''
  const customFooter = brand.comment_footer ? `\n\n${brand.comment_footer}` : ''

  const annotationTag = `\n\n${buildAnnotation({
    origin: input.origin ?? 'human',
    reviewer,
    model,
    type: stepType,
    round,
    verdict: input.verdict ?? 'UNKNOWN',
    service: serviceName,
  })}`

  const replyPrefix = input.replyToCommentId
    ? `> Recheck of [original review](#issuecomment-${input.replyToCommentId})\n\n`
    : ''

  return customHeader + replyPrefix + header + input.body + footer + customFooter + annotationTag
}

export async function postReviewComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  body: string,
  reviewer: string,
  brand: BrandOptions = {},
  origin: string = 'human',
  verdict?: string | null,
  replyToCommentId?: number,
  isRecheck?: boolean,
  model = 'default',
  stepType?: CrosscheckStepType,
  round = 1,
): Promise<number> {

  const { data: comment } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: pullNumber,
    body: buildReviewCommentBody({
      body,
      reviewer,
      brand,
      origin,
      verdict,
      replyToCommentId,
      isRecheck,
      model,
      stepType,
      round,
    }),
  })
  return comment.id
}

function stepVerb(stepType: CrosscheckStepType): string {
  if (stepType === 'recheck') return 'Recheck'
  if (stepType === 'fix') return 'Fixes'
  if (stepType === 'conflict-resolve') return 'Conflict resolution'
  return 'Code Review'
}
