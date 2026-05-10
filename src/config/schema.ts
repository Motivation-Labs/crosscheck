import { z } from 'zod'

export const VendorConfigSchema = z.object({
  enabled: z.boolean().default(true),
  model: z.string().nullable().default(null),
  auth: z.enum(['subscription', 'api-key']).default('subscription'),
  effort: z.enum(['low', 'medium', 'high', 'max']).default('medium'),
})

// Codex-specific vendor config. The `quality` field is retained for
// backwards compat but is no longer passed as --quality (removed from codex CLI).
export const CodexVendorConfigSchema = VendorConfigSchema.extend({
  quality: z.enum(['low', 'medium', 'high']).default('medium'),
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
    'Generated with \\[Claude Code\\]',  // PR body attribution footer
    'Co-Authored-By: Claude',            // commit trailer added by Claude Code
  ]),
  claude_reviews_patterns: z.array(z.string()).default([
    'Generated with \\[OpenAI Codex\\]', // PR body attribution footer
    'Co-Authored-By: codex',             // commit trailer added by Codex
  ]),
  // Branch prefix routing — checked when body and commit patterns don't match.
  // Agents should branch with these prefixes so crosscheck can identify origin
  // even without attribution text in the PR body.
  claude_branch_prefixes: z.array(z.string()).default(['claude/']),
  codex_branch_prefixes: z.array(z.string()).default(['codex/']),
  // Only review PRs opened by these GitHub logins.
  // Empty list = no restriction (reviews all AI-authored PRs in cross-vendor mode,
  // or all PRs in single-vendor mode). Recommended: set to the logins of your AI agents.
  allowed_authors: z.array(z.string()).default([]),
  // Last-resort fallback when body, commit, and branch checks all fail.
  // Maps GitHub login → vendor origin.
  // e.g. { beingzy: 'claude' } means PRs from beingzy are treated as Claude-authored
  // and will be reviewed by Codex, even without any other attribution signal.
  author_routes: z.record(z.enum(['claude', 'codex'])).default({}),
  // When origin detection cannot determine a vendor (origin: human), use this reviewer
  // instead of skipping the PR.
  // 'auto' = pick whichever vendor is currently enabled (codex first, then claude).
  // null   = skip the PR (legacy behaviour, cross-vendor mode only).
  fallback_reviewer: z.enum(['auto', 'codex', 'claude']).nullable().default('auto'),
})

export const ServerConfigSchema = z.object({
  port: z.number().default(7891),
  webhook_path: z.string().default('/webhook'),
})

export const LogsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  retention_days: z.number().int().min(1).max(30).default(7),
})

export const TunnelConfigSchema = z.object({
  // localhost.run: zero-config SSH tunnel, reconnects automatically, no install required.
  // smee: webhook relay via smee.io — events queued while offline, stable channel URL.
  //   Requires: npm install -g smee-client  and  tunnel.smee_channel set below.
  backend: z.enum(['localhost.run', 'smee']).default('localhost.run'),
  smee_channel: z.string().default(''),
})

export const ImpactConfigSchema = z.object({
  assumed_human_review_minutes: z.number().int().min(1).default(60),
  hourly_rate_usd: z.number().min(0).default(150),
  defect_cost_usd: z.number().min(0).default(150),
})

export const BacktraceConfigSchema = z.object({
  // Scan for open PRs without a [crosscheck] comment on startup.
  enabled: z.boolean().default(true),
})

export const PostReviewDeliverySchema = z.object({
  // pull_request → opens a fix PR targeting the original branch (human approves before merge)
  // commit       → pushes fixes directly onto the original PR branch
  // comment      → posts suggested changes as review comments only (no code push)
  mode: z.enum(['pull_request', 'commit', 'comment']).default('pull_request'),
  pr_title: z.string().default('fix: address CR issues in #{original_pr_title}'),
  label: z.string().default('cr-autofix'),
})

// Trigger conditions, vendor selection, and step sequencing are all defined in
// workflow.yml (type, when, reviewer). This schema retains only the delivery
// mechanism — how fixes land on the PR — which is operational config, not pipeline logic.
export const PostReviewFixSchema = z.object({
  delivery: PostReviewDeliverySchema.default({}),
  // Migration compat: honored with a deprecation warning but no longer the control plane.
  // Remove these from config and use workflow.yml to control when fix steps run.
  enabled: z.boolean().optional(),
  trigger: z.enum(['on_issues', 'always', 'never']).optional(),
})

export const PostReviewConfigSchema = z.object({
  auto_fix: PostReviewFixSchema.default({}),
})

export const DisplayThemeSchema = z.object({
  bar_fill: z.string().default('blue'),
  bar_empty: z.string().default('dim'),
  cr_approve: z.string().default('green'),
  cr_needs_work: z.string().default('yellow'),
  cr_block: z.string().default('red'),
  fix_fill: z.string().default('cyan'),
})

export const DisplayConfigSchema = z.object({
  theme: DisplayThemeSchema.default({}),
})

export const BrandConfigSchema = z.object({
  service_name: z.string().default('crosscheck'),
  comment_header: z.string().default(''),
  comment_footer: z.string().default(''),
  reviewer_attribution: z.string().default(''),
})

export const ConfigSchema = z.object({
  // Absent = not yet configured; watch/serve will prompt on first run.
  deployment: z.enum(['personal', 'team']).optional(),
  mode: z.enum(['single-vendor', 'cross-vendor']).default('cross-vendor'),
  vendors: z.object({
    codex: CodexVendorConfigSchema.default({}),
    claude: VendorConfigSchema.default({}),
  }).default({}),
  quality: QualityConfigSchema.default({}),
  budget: BudgetConfigSchema.default({}),
  orgs: z.array(z.string()).default([]),
  users: z.array(z.string()).default([]),
  repos: z.array(RepoConfigSchema).default([]),
  routing: RoutingConfigSchema.default({}),
  server: ServerConfigSchema.default({}),
  tunnel: TunnelConfigSchema.default({}),
  logs: LogsConfigSchema.default({}),
  impact: ImpactConfigSchema.default({}),
  backtrace: BacktraceConfigSchema.default({}),
  post_review: PostReviewConfigSchema.default({}),
  display: DisplayConfigSchema.default({}),
  brand: BrandConfigSchema.default({}),
})

export type Config = z.infer<typeof ConfigSchema>
export type BrandConfig = z.infer<typeof BrandConfigSchema>
export type VendorConfig = z.infer<typeof VendorConfigSchema>
export type CodexVendorConfig = z.infer<typeof CodexVendorConfigSchema>
export type QualityConfig = z.infer<typeof QualityConfigSchema>
export type LogsConfig = z.infer<typeof LogsConfigSchema>
export type TunnelConfig = z.infer<typeof TunnelConfigSchema>
export type ImpactConfig = z.infer<typeof ImpactConfigSchema>
export type PostReviewConfig = z.infer<typeof PostReviewConfigSchema>
export type PostReviewFixConfig = z.infer<typeof PostReviewFixSchema>
export type DisplayConfig = z.infer<typeof DisplayConfigSchema>
export type DisplayTheme = z.infer<typeof DisplayThemeSchema>
export type BacktraceConfig = z.infer<typeof BacktraceConfigSchema>
