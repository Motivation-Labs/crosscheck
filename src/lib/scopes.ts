// A monitoring scope — either an org (covers all its repos) or one specific repo.
export type Scope = { org: string } | { owner: string; repo: string }

export interface DedupResult {
  scopes: Scope[]
  // org name → list of repo names whose scope was dropped because that org already covers them.
  // Preserves first-seen order both at the org level (Map insertion order) and within each list.
  dropped: Map<string, string[]>
}

// Removes `{owner, repo}` scopes whose owner is already declared as an `{org}` scope.
// Registering both would cause GitHub to deliver every PR event twice (one delivery
// per webhook), so we collapse to org-only for those repos. Other scopes pass through
// unchanged, preserving original input order.
export function dedupScopes(input: Scope[]): DedupResult {
  const orgs = new Set<string>()
  for (const s of input) if ('org' in s) orgs.add(s.org)

  const scopes: Scope[] = []
  const dropped = new Map<string, string[]>()

  for (const s of input) {
    if ('org' in s) {
      scopes.push(s)
      continue
    }
    if (orgs.has(s.owner)) {
      const list = dropped.get(s.owner) ?? []
      list.push(s.repo)
      dropped.set(s.owner, list)
      continue
    }
    scopes.push(s)
  }

  return { scopes, dropped }
}
