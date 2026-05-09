import type { Config } from '../config/schema.js'
import { getPRCommits } from './client.js'

export type PROrigin = 'claude' | 'codex' | 'human'

// Applies codex_reviews_patterns / claude_reviews_patterns against a single text block.
// Returns the detected origin or null if nothing matched.
function matchPatterns(text: string, config: Config): PROrigin | null {
  for (const pattern of config.routing.codex_reviews_patterns) {
    if (new RegExp(pattern, 'i').test(text)) return 'claude'
  }
  for (const pattern of config.routing.claude_reviews_patterns) {
    if (new RegExp(pattern, 'i').test(text)) return 'codex'
  }
  return null
}

// Step 1 — PR body patterns
export function detectOriginFromBody(prBody: string, config: Config): PROrigin | null {
  return matchPatterns(prBody ?? '', config)
}

// Step 2 — commit Co-Authored-By trailers (fetched separately, passed in)
export function detectOriginFromCommits(messages: string[], config: Config): PROrigin | null {
  for (const msg of messages) {
    const result = matchPatterns(msg, config)
    if (result !== null) return result
  }
  return null
}

// Step 3 — branch name prefix
export function detectOriginFromBranch(headRef: string, config: Config): PROrigin | null {
  for (const prefix of config.routing.claude_branch_prefixes) {
    if (headRef.startsWith(prefix)) return 'claude'
  }
  for (const prefix of config.routing.codex_branch_prefixes) {
    if (headRef.startsWith(prefix)) return 'codex'
  }
  return null
}

// Full detection chain: body → commits → branch → author_routes → human
// API failure on the commits fetch is non-fatal; falls through to branch check.
export async function detectOriginFull(
  prBody: string,
  headRef: string,
  owner: string,
  repo: string,
  prNumber: number,
  config: Config,
  token: string,
  author?: string,
): Promise<{ origin: PROrigin; method: string }> {
  const fromBody = detectOriginFromBody(prBody, config)
  if (fromBody !== null) return { origin: fromBody, method: 'body' }

  try {
    const messages = await getPRCommits(owner, repo, prNumber, token)
    const fromCommits = detectOriginFromCommits(messages, config)
    if (fromCommits !== null) return { origin: fromCommits, method: 'commits' }
  } catch { /* API failure — fall through */ }

  const fromBranch = detectOriginFromBranch(headRef, config)
  if (fromBranch !== null) return { origin: fromBranch, method: 'branch' }

  if (author && config.routing.author_routes[author]) {
    return { origin: config.routing.author_routes[author], method: 'author_routes' }
  }

  return { origin: 'human', method: 'none' }
}

// Backward-compatible sync variant (body + author_routes only).
// Use detectOriginFull for the full async chain.
export function detectPROrigin(prBody: string, config: Config, author?: string): PROrigin {
  return detectOriginFromBody(prBody, config)
    ?? (author ? (config.routing.author_routes[author] ?? null) : null)
    ?? 'human'
}

export function shouldReview(origin: PROrigin, config: Config): boolean {
  if (config.mode === 'single-vendor') return true
  return origin === 'claude' || origin === 'codex'
}

export function assignReviewer(origin: PROrigin, config: Config): 'claude' | 'codex' | null {
  if (config.mode === 'single-vendor') {
    if (config.vendors.codex.enabled) return 'codex'
    if (config.vendors.claude.enabled) return 'claude'
    return null
  }
  if (origin === 'claude' && config.vendors.codex.enabled) return 'codex'
  if (origin === 'codex' && config.vendors.claude.enabled) return 'claude'
  return null
}
