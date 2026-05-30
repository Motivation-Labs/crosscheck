import type { Config } from '../config/schema.js'
import { isAuthorAllowed } from './filter.js'
import {
  listCommitStatuses,
  listOpenPRs,
  listOrgRepos,
  listPRComments,
  listPRCommitsDetailed,
  listUserRepos,
  prHasCrossCheckComment,
  type OpenPR,
} from '../github/client.js'
import {
  foldPRStatus,
  isStale,
  type PRStatus,
  type PRStatusLogEvent,
  type PRStatusPullRequest,
} from './pr-status.js'

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

export interface ScanFailure {
  owner?: string
  repo?: string
  pr?: number
  stage: 'scope' | 'repo' | 'pr'
  message: string
}

export interface ScanOptions {
  logEvents?: PRStatusLogEvent[]
  staleAfter?: number
}

export interface ScanResult {
  statuses: PRStatus[]
  failures: ScanFailure[]
  skippedAuthor: number
  scannedRepos: number
  scannedPRs: number
}

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

async function expandToReposWithFailures(
  scopes: BacktraceScope[],
  token: string,
): Promise<{ repos: Array<{ owner: string; repo: string }>; failures: ScanFailure[] }> {
  const expanded = await Promise.all(
    scopes.map(async (scope) => {
      if ('org' in scope) {
        try {
          const orgRepos = await listOrgRepos(scope.org, token)
          return {
            repos: orgRepos.map(({ owner, name }) => ({ owner, repo: name })),
            failures: [] as ScanFailure[],
          }
        } catch (err: unknown) {
          return {
            repos: [],
            failures: [{ stage: 'scope' as const, owner: scope.org, message: err instanceof Error ? err.message : String(err) }],
          }
        }
      }
      return { repos: [{ owner: scope.owner, repo: scope.repo }], failures: [] as ScanFailure[] }
    }),
  )

  return {
    repos: expanded.flatMap(result => result.repos),
    failures: expanded.flatMap(result => result.failures),
  }
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

export async function scanOpenPRStatuses(
  scopes: BacktraceScope[],
  config: Config,
  token: string,
  opts: ScanOptions = {},
): Promise<ScanResult> {
  if (scopes.length === 0) {
    return { statuses: [], failures: [], skippedAuthor: 0, scannedRepos: 0, scannedPRs: 0 }
  }

  const expanded = await expandToReposWithFailures(scopes, token)

  const perRepoResults = await Promise.all(
    expanded.repos.map(async ({ owner, repo }) => {
      try {
        const prs = await listOpenPRs(owner, repo, token)
        return { prs: prs.map<BacktracePR>(pr => ({ ...pr, owner, repo })), failures: [] as ScanFailure[] }
      } catch (err: unknown) {
        return {
          prs: [],
          failures: [{ owner, repo, stage: 'repo' as const, message: err instanceof Error ? err.message : String(err) }],
        }
      }
    }),
  )

  const allPRs = perRepoResults.flatMap(result => result.prs)
  let skippedAuthor = 0
  const allowedPRs = allPRs.filter((pr) => {
    if (isAuthorAllowed(config.routing.allowed_authors, pr.author)) return true
    skippedAuthor++
    return false
  })

  const perPRResults = await Promise.all(
    allowedPRs.map(async (pr) => {
      try {
        const [comments, commits, commitStatuses] = await Promise.all([
          listPRComments(pr.owner, pr.repo, pr.number, token),
          listPRCommitsDetailed(pr.owner, pr.repo, pr.number, token),
          listCommitStatuses(pr.owner, pr.repo, pr.headSha, token),
        ])
        const statusPR: PRStatusPullRequest = {
          ...pr,
          commits,
          commitStatuses,
        }
        const status = foldPRStatus(statusPR, comments, opts.logEvents ?? [])
        if (opts.staleAfter !== undefined) status.stale = isStale(status, opts.staleAfter)
        return { status, failure: null }
      } catch (err: unknown) {
        return {
          status: null,
          failure: {
            owner: pr.owner,
            repo: pr.repo,
            pr: pr.number,
            stage: 'pr' as const,
            message: err instanceof Error ? err.message : String(err),
          },
        }
      }
    }),
  )

  const statuses = perPRResults.flatMap(result => result.status ? [result.status] : [])
  statuses.sort((a, b) => a.lastActive.getTime() - b.lastActive.getTime())

  return {
    statuses,
    failures: [
      ...expanded.failures,
      ...perRepoResults.flatMap(result => result.failures),
      ...perPRResults.flatMap(result => result.failure ? [result.failure] : []),
    ],
    skippedAuthor,
    scannedRepos: expanded.repos.length,
    scannedPRs: allPRs.length,
  }
}
