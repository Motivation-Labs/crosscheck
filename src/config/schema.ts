import { z } from 'zod'

export const VendorConfigSchema = z.object({
  enabled: z.boolean().default(true),
  model: z.string().optional(),
  auth: z.enum(['subscription', 'api-key']).default('subscription'),
  effort: z.enum(['low', 'medium', 'high', 'max']).default('medium'),
})

export const QualityConfigSchema = z.object({
  tier: z.enum(['fast', 'balanced', 'thorough']).default('balanced'),
  focus: z.array(z.string()).default([]),
  custom_prompt: z.string().optional(),
})

export const BudgetConfigSchema = z.object({
  codex_monthly_usd: z.number().nullable().default(null),
  per_review_usd: z.number().default(2.0),
})

export const RepoConfigSchema = z.object({
  owner: z.string(),
  name: z.string(),
})

export const RoutingConfigSchema = z.object({
  codex_reviews_patterns: z.array(z.string()).default([
    'Generated with \\[Claude Code\\]',
  ]),
  claude_reviews_patterns: z.array(z.string()).default([
    'Generated with \\[OpenAI Codex\\]',
    'Co-Authored-By: codex',
  ]),
  // Only review PRs opened by these GitHub logins.
  // Empty list = no restriction (reviews all AI-authored PRs in cross-vendor mode,
  // or all PRs in single-vendor mode). Recommended: set to the logins of your AI agents.
  allowed_authors: z.array(z.string()).default([]),
})

export const ServerConfigSchema = z.object({
  port: z.number().default(7891),
  webhook_path: z.string().default('/webhook'),
})

export const LogsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  retention_days: z.number().int().min(1).max(30).default(7),
})

export const ConfigSchema = z.object({
  mode: z.enum(['single-vendor', 'cross-vendor']).default('cross-vendor'),
  vendors: z.object({
    codex: VendorConfigSchema.default({}),
    claude: VendorConfigSchema.default({}),
  }).default({}),
  quality: QualityConfigSchema.default({}),
  budget: BudgetConfigSchema.default({}),
  orgs: z.array(z.string()).default([]),
  repos: z.array(RepoConfigSchema).default([]),
  routing: RoutingConfigSchema.default({}),
  server: ServerConfigSchema.default({}),
  logs: LogsConfigSchema.default({}),
})

export type Config = z.infer<typeof ConfigSchema>
export type VendorConfig = z.infer<typeof VendorConfigSchema>
export type QualityConfig = z.infer<typeof QualityConfigSchema>
export type LogsConfig = z.infer<typeof LogsConfigSchema>
