// A monitoring scope — either an org (covers all its repos) or one specific repo.
export type Scope = { org: string } | { owner: string; repo: string }

export interface DedupResult {
  scopes: Scope[]
  // org name → list of repo names whose scope was dropped because that org already covers them.
  // Preserves first-seen order both at the org level (Map insertion order) and within each list.
  dropped: Map<string, string[]>
  // org name → original repo scopes dropped from primary registration. Watch uses these as
  // fallbacks when org hook registration fails but explicit repo hook registration could succeed.
  fallbackRepos: Map<string, Array<{ owner: string; repo: string }>>
}

// Removes `{owner, repo}` scopes whose owner is already declared as an `{org}` scope.
// Registering both would cause GitHub to deliver every PR event twice (one delivery
// per webhook), so we collapse to org-only for those repos. Other scopes pass through
// unchanged, preserving original input order.
//
// Comparison is case-insensitive: GitHub owner names are case-insensitive, so
// `orgs: [humanbased-ai]` subsumes `repos: [humanbased-ai/foo]`. The dropped map
// is keyed by the original-case org name from the `{org}` scope entry.
export function dedupScopes(input: Scope[]): DedupResult {
  const orgs = new Map<string, string>()
  for (const s of input) {
    if ('org' in s && !orgs.has(s.org.toLowerCase())) orgs.set(s.org.toLowerCase(), s.org)
  }

  const scopes: Scope[] = []
  const dropped = new Map<string, string[]>()
  const fallbackRepos = new Map<string, Array<{ owner: string; repo: string }>>()

  for (const s of input) {
    if ('org' in s) {
      scopes.push(s)
      continue
    }
    const coveringOrg = orgs.get(s.owner.toLowerCase())
    if (coveringOrg) {
      const list = dropped.get(coveringOrg) ?? []
      list.push(s.repo)
      dropped.set(coveringOrg, list)
      const fallbackList = fallbackRepos.get(coveringOrg) ?? []
      fallbackList.push({ owner: s.owner, repo: s.repo })
      fallbackRepos.set(coveringOrg, fallbackList)
      continue
    }
    scopes.push(s)
  }

  return { scopes, dropped, fallbackRepos }
}
