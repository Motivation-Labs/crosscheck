import type { QualityConfig } from '../config/schema.js'

// Default reviewer subprocess timeouts per quality tier. Applied when
// neither --timeout nor vendor.timeout_sec is set. Both claude and codex
// reviewers share this table so that quality.tier has a consistent effect
// across vendors.
export const TIER_TIMEOUT_MS: Record<QualityConfig['tier'], number> = {
  fast: 300_000,
  balanced: 600_000,
  thorough: 1_200_000,
}

export const DEFAULT_TIER_TIMEOUT_MS = TIER_TIMEOUT_MS.balanced

export function tierTimeoutMs(tier: QualityConfig['tier']): number {
  return TIER_TIMEOUT_MS[tier] ?? DEFAULT_TIER_TIMEOUT_MS
}
