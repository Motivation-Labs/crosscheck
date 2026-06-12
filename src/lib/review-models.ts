import type { CodexVendorConfig, QualityConfig, VendorConfig } from '../config/schema.js'

export const CLAUDE_TIER_MODELS: Record<string, string> = {
  fast: 'claude-haiku-4-5-20251001',
  balanced: 'claude-sonnet-4-6',
  thorough: 'claude-opus-4-7',
}

export const CODEX_TIER_MODELS_API: Record<string, string> = {
  fast: 'gpt-4o-mini',
  balanced: 'o4-mini',
  thorough: 'o3',
}

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  'claude-opus-4-8': 'Opus 4.8',
  'claude-opus-4-7': 'Opus 4.7',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
  'o4-mini': 'o4-mini',
  'o3': 'o3',
  'gpt-4o-mini': 'gpt-4o-mini',
}

export function resolveClaudeModel(quality: QualityConfig, vendor?: VendorConfig): string {
  // An explicit vendors.claude.model wins over the tier mapping. The claude CLI
  // accepts --model under both subscription and api-key auth (unlike Codex), so
  // we honor it regardless of auth instead of silently dropping it.
  if (vendor?.model) return vendor.model
  return CLAUDE_TIER_MODELS[quality.tier] ?? CLAUDE_TIER_MODELS.balanced
}

export function resolveCodexModel(quality: QualityConfig, vendor: CodexVendorConfig): string {
  if (vendor.auth !== 'api-key') return 'default'
  return vendor.model || CODEX_TIER_MODELS_API[quality.tier] || CODEX_TIER_MODELS_API.balanced
}

export function modelDisplayName(model: string): string | null {
  if (model === 'default') return null
  return MODEL_DISPLAY_NAMES[model] ?? model
}

// Extracts the model that actually served the session from the claude CLI's
// `modelUsage` JSON field (keyed by full model ID). The requested model may be
// an alias ("opus") or be substituted by the CLI, so this is the ground truth.
// When several models appear (e.g. a helper model alongside the main one), the
// one with the most output tokens is the reviewer. Returns null when the field
// is missing or malformed.
export function primaryModelFromUsage(modelUsage: unknown): string | null {
  if (modelUsage === null || typeof modelUsage !== 'object') return null
  let best: string | null = null
  let bestTokens = -1
  for (const [id, usage] of Object.entries(modelUsage)) {
    const out = (usage as { outputTokens?: unknown } | null)?.outputTokens
    const tokens = typeof out === 'number' ? out : 0
    if (tokens > bestTokens) {
      bestTokens = tokens
      best = id
    }
  }
  return best
}
