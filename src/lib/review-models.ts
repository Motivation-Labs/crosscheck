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
