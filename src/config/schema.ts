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
})

export const ServerConfigSchema = z.object({
  port: z.number().default(7891),
  webhook_path: z.string().default('/webhook'),
})

export const ConfigSchema = z.object({
  mode: z.enum(['single-vendor', 'cross-vendor']).default('cross-vendor'),
  vendors: z.object({
    codex: VendorConfigSchema.default({}),
    claude: VendorConfigSchema.default({}),
  }).default({}),
  quality: QualityConfigSchema.default({}),
  budget: BudgetConfigSchema.default({}),
  repos: z.array(RepoConfigSchema).default([]),
  routing: RoutingConfigSchema.default({}),
  server: ServerConfigSchema.default({}),
})

export type Config = z.infer<typeof ConfigSchema>
export type VendorConfig = z.infer<typeof VendorConfigSchema>
export type QualityConfig = z.infer<typeof QualityConfigSchema>
