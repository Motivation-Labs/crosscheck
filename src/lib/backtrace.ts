import type { Config } from '../config/schema.js'
import { isAuthorAllowed } from './filter.js'
import {
  listOpenPRs,
  listOrgRepos,
  listUserRepos,
  prHasCrossCheckComment,
  type OpenPR,
} from '../github/client.js'

export type BacktraceScope = { org: string } | { owner: string; repo: string }

export interface BacktracePR extends OpenPR {
  owner: string
  repo: string
}

export interface BacktraceResult {
  queued: BacktracePR[]
  alreadyReviewed: number
  skippedAuthor: number
}

// Resolve org and user scopes to individual {owner, repo} pairs.
async function expandToRepos(
  scopes: BacktraceScope[],
  token: string,
): Promise<Array<{ owner: string; repo: string }>> {
  const repos: Array<{ owner: string; repo: string }> = []
  await Promise.all(
    scopes.map(async (scope) => {
      if ('org' in scope) {
        try {
          const orgRepos = await listOrgRepos(scope.org, token)
          for (const { owner, name } of orgRepos) repos.push({ owner, repo: name })
        } catch { /* skip org on API error */ }
      } else {
        repos.push({ owner: scope.owner, repo: scope.repo })
      }
    })
  )
  return repos
}

// Build backtrace scopes from config (used by serve mode; watch mode passes
// its already-resolved scopes array directly).
export async function buildScopesFromConfig(
  config: Config,
  token: string,
): Promise<BacktraceScope[]> {
  const scopes: BacktraceScope[] = [
    ...config.orgs.map(org => ({ org }) as BacktraceScope),
    ...config.repos.map(r => ({ owner: r.owner, repo: r.name }) as BacktraceScope),
  ]
  await Promise.all(
    config.users.map(async (user) => {
      try {
        const repos = await listUserRepos(user, token)
        for (const { owner, name } of repos) scopes.push({ owner, repo: name })
      } catch { /* skip user on API error */ }
    })
  )
  return scopes
}

// Scan all open PRs in the given scopes and return those that have never
// received a [crosscheck] review comment and pass the allowed_authors filter.
// Results are sorted oldest-first. API errors for individual PRs or repos
// are silently skipped so one bad repo never blocks the rest.
export async function scanUnreviewedPRs(
  scopes: BacktraceScope[],
  config: Config,
  token: string,
): Promise<BacktraceResult> {
  if (scopes.length === 0) {
    return { queued: [], alreadyReviewed: 0, skippedAuthor: 0 }
  }

  const repoScopes = await expandToRepos(scopes, token)

  const perRepoResults = await Promise.all(
    repoScopes.map(async ({ owner, repo }) => {
      try {
        const prs = await listOpenPRs(owner, repo, token)
        return prs.map<BacktracePR>(pr => ({ ...pr, owner, repo }))
      } catch {
        return [] as BacktracePR[]
      }
    })
  )
  const allPRs = perRepoResults.flat()

  const result: BacktraceResult = { queued: [], alreadyReviewed: 0, skippedAuthor: 0 }

  await Promise.all(
    allPRs.map(async (pr) => {
      if (!isAuthorAllowed(config.routing.allowed_authors, pr.author)) {
        result.skippedAuthor++
        return
      }
      try {
        if (await prHasCrossCheckComment(pr.owner, pr.repo, pr.number, token)) {
          result.alreadyReviewed++
        } else {
          result.queued.push(pr)
        }
      } catch { /* skip PR on API error */ }
    })
  )

  result.queued.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())

  return result
}
