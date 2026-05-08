import type { Config } from '../config/schema.js'

export type PROrigin = 'claude' | 'codex' | 'human'

export function detectPROrigin(prBody: string, config: Config, author?: string): PROrigin {
  const body = prBody ?? ''

  for (const pattern of config.routing.codex_reviews_patterns) {
    if (new RegExp(pattern, 'i').test(body)) return 'claude'
  }

  for (const pattern of config.routing.claude_reviews_patterns) {
    if (new RegExp(pattern, 'i').test(body)) return 'codex'
  }

  // Author-based fallback: use explicit route when body patterns don't match
  if (author && config.routing.author_routes[author]) {
    return config.routing.author_routes[author]
  }

  return 'human'
}

export function shouldReview(origin: PROrigin, config: Config): boolean {
  if (config.mode === 'single-vendor') return true

  // cross-vendor: only review PRs from the other AI
  return origin === 'claude' || origin === 'codex'
}

export function assignReviewer(origin: PROrigin, config: Config): 'claude' | 'codex' | null {
  if (config.mode === 'single-vendor') {
    // use whichever vendor is enabled
    if (config.vendors.codex.enabled) return 'codex'
    if (config.vendors.claude.enabled) return 'claude'
    return null
  }

  // cross-vendor: opposite vendor reviews
  if (origin === 'claude' && config.vendors.codex.enabled) return 'codex'
  if (origin === 'codex' && config.vendors.claude.enabled) return 'claude'
  return null
}
