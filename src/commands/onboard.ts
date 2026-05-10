import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import chalk from 'chalk'
import { createInterface } from 'readline'
import yaml from 'js-yaml'
import {
  getGithubToken,
  loadConfig,
  resolveConfigPath,
  detectGitHubLogin,
} from '../config/loader.js'
import { listUserOrgs, listOrgRepos, fetchActiveRepos, type RepoActivity } from '../github/client.js'
import { checkCodexAuth } from '../reviewers/codex.js'
import { checkClaudeAuth } from '../reviewers/claude.js'
import { execSync } from 'child_process'
import { promptRepoPicker, promptSinglePicker, type PickerItem } from '../lib/repo-picker.js'

export interface OnboardOpts {
  config?: string
  yes?: boolean
  personal?: boolean
  team?: boolean
  reconfigure?: boolean
}

interface EnvCheckResult {
  ok: boolean
  claudeOk: boolean
  codexOk: boolean
}

type WorkflowPreset = 'review-only' | 'review-fix' | 'review-fix-recheck'

type VendorModeConfig = {
  mode: 'cross-vendor' | 'single-vendor'
  claudeEnabled: boolean
  codexEnabled: boolean
}

// Model and effort settings for each quality tier.
// These are written directly to vendors.claude / vendors.codex in the config.
const QUALITY_TIERS = {
  fast: {
    description: 'quick scan, top issues only  (~10s, lowest cost)',
    claude: { model: 'haiku', effort: 'low' as const },
    codex:  { model: 'o4-mini', effort: 'low' as const },
  },
  balanced: {
    description: 'full review, all issues with explanations  (~30s)',
    claude: { model: 'sonnet', effort: 'medium' as const },
    codex:  { model: 'o4-mini', effort: 'medium' as const },
  },
  thorough: {
    description: 'deep multi-pass, security + architecture  (~60s+, higher cost)',
    claude: { model: 'opus', effort: 'max' as const },
    codex:  { model: 'o3', effort: 'high' as const },
  },
} as const

type QualityTier = keyof typeof QUALITY_TIERS

function ask(question: string): Promise<string> {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, answer => { rl.close(); resolve(answer.trim()) })
  })
}

function formatAge(date: Date): string {
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000)
  if (days === 0) return 'today'
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

async function checkEnv(): Promise<EnvCheckResult> {
  let codexOk = false
  let claudeOk = false

  try {
    execSync('codex --version 2>&1', { encoding: 'utf8' })
    const auth = await checkCodexAuth()
    codexOk = auth.ok
    const icon = auth.ok ? chalk.green('✓') : chalk.red('✗')
    console.log(`  ${icon} ${'codex CLI'.padEnd(20)} ${auth.detail}`)
    if (!auth.ok) console.log(`      ${chalk.dim('→')} ${chalk.yellow('Run: codex login --device-auth')}`)
  } catch {
    console.log(`  ${chalk.red('✗')} ${'codex CLI'.padEnd(20)} not found`)
    console.log(`      ${chalk.dim('→')} ${chalk.yellow('Install: npm install -g @openai/codex')}`)
  }

  try {
    const auth = await checkClaudeAuth()
    claudeOk = auth.ok
    const icon = auth.ok ? chalk.green('✓') : chalk.red('✗')
    console.log(`  ${icon} ${'claude CLI'.padEnd(20)} ${auth.detail}`)
    if (!auth.ok) console.log(`      ${chalk.dim('→')} ${chalk.yellow('Run: claude auth login')}`)
  } catch {
    console.log(`  ${chalk.red('✗')} ${'claude CLI'.padEnd(20)} not found`)
    console.log(`      ${chalk.dim('→')} ${chalk.yellow('Install: npm install -g @anthropic-ai/claude-code')}`)
  }

  const envToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  let ghAuthed = false
  try {
    execSync('gh --version 2>&1', { encoding: 'utf8' })
    let authOutput = ''
    try { authOutput = execSync('gh auth status 2>&1', { encoding: 'utf8' }) } catch { /* GITHUB_TOKEN in use */ }
    ghAuthed = authOutput.includes('Logged in') || !!envToken
    const icon = ghAuthed ? chalk.green('✓') : chalk.red('✗')
    console.log(`  ${icon} ${'gh CLI'.padEnd(20)} ${ghAuthed ? 'authenticated' : 'not authenticated'}`)
    if (!ghAuthed) console.log(`      ${chalk.dim('→')} ${chalk.yellow('Run: gh auth login')}`)
  } catch {
    console.log(`  ${chalk.red('✗')} ${'gh CLI'.padEnd(20)} not found`)
    console.log(`      ${chalk.dim('→')} ${chalk.yellow('Install: brew install gh && gh auth login')}`)
  }

  if (!claudeOk && !codexOk) {
    console.log(chalk.red('\nAt least one AI CLI (codex or claude) must be authenticated.\n'))
    return { ok: false, claudeOk, codexOk }
  }
  if (!ghAuthed) {
    console.log(chalk.red('\nGitHub auth is required to fetch repos and register webhooks.\n'))
    return { ok: false, claudeOk, codexOk }
  }
  return { ok: true, claudeOk, codexOk }
}

async function promptVendorMode(
  claudeOk: boolean,
  codexOk: boolean,
  existingMode: string | undefined,
  existingClaudeEnabled: boolean,
  existingCodexEnabled: boolean,
  opts: OnboardOpts,
): Promise<VendorModeConfig> {
  const bothAvailable = claudeOk && codexOk

  if (!bothAvailable) {
    const vendor = claudeOk ? 'claude' : 'codex'
    console.log(`  Mode: ${chalk.cyan('single-vendor')} (only ${chalk.bold(vendor)} is available)`)
    return { mode: 'single-vendor', claudeEnabled: claudeOk, codexEnabled: codexOk }
  }

  if (opts.yes) {
    const mode = (existingMode ?? 'cross-vendor') as 'cross-vendor' | 'single-vendor'
    console.log(`  Mode: ${chalk.cyan(mode)}`)
    return { mode, claudeEnabled: existingClaudeEnabled, codexEnabled: existingCodexEnabled }
  }

  const modeItems: PickerItem[] = [
    { label: 'cross-vendor', description: 'Claude reviews Codex PRs; Codex reviews Claude PRs' },
    { label: 'single-vendor', description: 'one AI reviews all PRs' },
  ]
  const defaultModeIdx = existingMode === 'single-vendor' ? 1 : 0
  const modeIdx = await promptSinglePicker(modeItems, {
    title: 'How should reviews be assigned?',
    defaultIndex: defaultModeIdx,
  })
  console.log()

  if (modeIdx === 0) {
    return { mode: 'cross-vendor', claudeEnabled: true, codexEnabled: true }
  }

  // Single-vendor: ask which one
  const defaultVendorIdx = (existingMode === 'single-vendor' && existingCodexEnabled && !existingClaudeEnabled) ? 1 : 0
  const vendorItems: PickerItem[] = [
    { label: 'claude', description: 'Claude Code reviews all PRs' },
    { label: 'codex', description: 'OpenAI Codex reviews all PRs' },
  ]
  const vendorIdx = await promptSinglePicker(vendorItems, {
    title: 'Which AI should review all PRs?',
    defaultIndex: defaultVendorIdx,
  })
  console.log()

  return {
    mode: 'single-vendor',
    claudeEnabled: vendorIdx === 0,
    codexEnabled: vendorIdx === 1,
  }
}

async function promptQualityTier(
  claudeEnabled: boolean,
  codexEnabled: boolean,
  currentTier: string | undefined,
  opts: OnboardOpts,
): Promise<QualityTier> {
  if (opts.yes) {
    const tier = (currentTier ?? 'balanced') as QualityTier
    console.log(`  Quality: ${chalk.cyan(tier)}`)
    return tier
  }

  function modelHint(tier: QualityTier): string {
    const t = QUALITY_TIERS[tier]
    const parts: string[] = []
    if (claudeEnabled) parts.push(`claude: ${t.claude.model} · ${t.claude.effort} effort`)
    if (codexEnabled)  parts.push(`codex: ${t.codex.model} · ${t.codex.effort} effort`)
    return parts.join('  ·  ')
  }

  const tiers: QualityTier[] = ['fast', 'balanced', 'thorough']
  const items: PickerItem[] = tiers.map(tier => ({
    label: tier,
    description: QUALITY_TIERS[tier].description,
    hint: modelHint(tier),
  }))

  const defaultIdx = tiers.indexOf((currentTier ?? 'balanced') as QualityTier)
  const idx = await promptSinglePicker(items, {
    title: 'Review quality — how deep should the analysis go?',
    defaultIndex: defaultIdx >= 0 ? defaultIdx : 1,
  })
  console.log()

  return tiers[idx]
}

async function promptWorkflowPipeline(
  currentAutoFixEnabled: boolean | undefined,
  opts: OnboardOpts,
): Promise<WorkflowPreset> {
  if (opts.yes) {
    const globalWorkflowPath = join(homedir(), '.crosscheck', 'workflow.yml')
    const preset: WorkflowPreset = existsSync(globalWorkflowPath)
      ? 'review-fix-recheck'
      : currentAutoFixEnabled === true ? 'review-fix' : 'review-only'
    console.log(`  Pipeline: ${chalk.cyan(preset)}`)
    return preset
  }

  const globalWorkflowPath = join(homedir(), '.crosscheck', 'workflow.yml')
  const hasRecheckWorkflow = existsSync(globalWorkflowPath)
  const defaultIdx = hasRecheckWorkflow ? 2 : (currentAutoFixEnabled ? 1 : 1)

  const items: PickerItem[] = [
    { label: 'review only', description: 'AI posts a comment; you handle fixes' },
    { label: 'review → fix', description: 'AI reviews, then auto-applies fixes' },
    { label: 'review → fix → re-check', description: 'full loop: review, fix, then re-review to confirm' },
  ]

  const idx = await promptSinglePicker(items, {
    title: 'What should happen after a review?',
    defaultIndex: defaultIdx,
  })
  console.log()

  if (idx === 0) return 'review-only'
  if (idx === 2) return 'review-fix-recheck'
  return 'review-fix'
}

async function promptConnectionType(
  currentTunnel: 'localhost.run' | 'smee' | undefined,
  opts: OnboardOpts,
): Promise<'localhost.run' | 'smee'> {
  if (opts.yes) {
    const backend = currentTunnel ?? 'localhost.run'
    console.log(`  Connection: ${chalk.cyan(backend)}`)
    return backend
  }

  const items: PickerItem[] = [
    {
      label: 'localhost.run',
      description: 'zero-config SSH tunnel — reconnects automatically, no install needed',
    },
    {
      label: 'smee.io',
      description: 'webhook relay — events queued while offline, stable channel URL',
      hint: 'Get a free channel URL at smee.io/new — you\'ll paste it in the next step',
    },
  ]
  const defaultIdx = currentTunnel === 'smee' ? 1 : 0

  const idx = await promptSinglePicker(items, {
    title: 'How will GitHub reach your crosscheck server?',
    defaultIndex: defaultIdx,
  })
  console.log()

  return idx === 1 ? 'smee' : 'localhost.run'
}

export interface OnboardDecisions {
  deployment: 'personal' | 'team'
  login: string
  selectedRepos: string[]
  selectedOrgs: string[]
  vendorConfig: VendorModeConfig
  qualityTier: QualityTier
  pipelinePreset: WorkflowPreset
  tunnelBackend: 'localhost.run' | 'smee'
  smeeChannel: string
}

// Workflow YAML for the recheck preset — written to ~/.crosscheck/workflow.yml
const WORKFLOW_RECHECK_YAML = `# crosscheck workflow — generated by crosscheck onboard
# Place a .crosscheck/workflow.yml in your project root to override this global file.

on: [opened, synchronize]
steps:
  - name: review
    type: review
    reviewer: auto
    max_rounds: 1

  - name: fix
    type: fix
    reviewer: origin
    when: "review.verdict != 'APPROVE'"
    max_rounds: 1

  - name: recheck
    type: recheck
    reviewer: auto
    when: "fix.applied_count > 0"
    max_rounds: 1
`

// Writes all onboard decisions to configPath and manages the global workflow.yml.
// On re-runs, only the fields onboard owns are updated; everything else is preserved.
export function applyOnboardConfig(
  configPath: string,
  decisions: OnboardDecisions,
  workflowDir = join(homedir(), '.crosscheck'),
): void {
  const { deployment, login, selectedRepos, selectedOrgs, vendorConfig, qualityTier, pipelinePreset, tunnelBackend, smeeChannel } = decisions

  mkdirSync(dirname(configPath), { recursive: true })

  // Load existing config (preserves all custom fields) or start fresh
  const raw: Record<string, unknown> = existsSync(configPath)
    ? ((yaml.load(readFileSync(configPath, 'utf8')) ?? {}) as Record<string, unknown>)
    : {}

  // ── Fields onboard always owns ─────────────────────────────────────────────
  raw.deployment = deployment
  raw.orgs = selectedOrgs
  raw.mode = vendorConfig.mode

  // Repos
  raw.repos = selectedRepos.map(r => {
    const [owner, name] = r.split('/')
    return { owner, name }
  })

  // Users: personal mode captures the login; team mode never uses users
  if (deployment === 'personal' && login) {
    raw.users = [login]
  } else {
    delete raw.users  // team mode, or personal with no login
  }
  // Scope covered by repos/orgs — users entry not needed even in personal mode
  if (selectedRepos.length > 0 || selectedOrgs.length > 0) {
    delete raw.users
  }

  // ── Routing: initialise missing fields; never overwrite fields that are set ──
  // Guards on individual fields so a partial routing object (e.g. from an
  // unpatched example config) still gets the personal-mode defaults filled in.
  if (!raw.routing || typeof raw.routing !== 'object') raw.routing = {}
  const routing = raw.routing as Record<string, unknown>

  if (deployment === 'personal' && login) {
    const currentAuthors = Array.isArray(routing.allowed_authors) ? (routing.allowed_authors as string[]) : []
    if (currentAuthors.length === 0) routing.allowed_authors = [login]

    const currentRoutes = routing.author_routes != null && typeof routing.author_routes === 'object'
      ? (routing.author_routes as Record<string, string>)
      : null
    if (!currentRoutes || Object.keys(currentRoutes).length === 0) {
      routing.author_routes = { [login]: 'claude' }
    }
  }
  if (routing.fallback_reviewer === undefined) routing.fallback_reviewer = 'auto'

  // ── Vendors ─────────────────────────────────────────────────────────────────
  if (!raw.vendors || typeof raw.vendors !== 'object') raw.vendors = {}
  const vendors = raw.vendors as Record<string, Record<string, unknown>>
  if (!vendors.claude) vendors.claude = {}
  if (!vendors.codex) vendors.codex = {}
  vendors.claude.enabled = vendorConfig.claudeEnabled
  vendors.codex.enabled = vendorConfig.codexEnabled

  // ── Tunnel ──────────────────────────────────────────────────────────────────
  if (!raw.tunnel || typeof raw.tunnel !== 'object') raw.tunnel = {}
  const tunnelObj = raw.tunnel as Record<string, unknown>
  tunnelObj.backend = tunnelBackend
  if (tunnelBackend === 'smee' && smeeChannel) tunnelObj.smee_channel = smeeChannel

  // ── Quality tier + per-vendor effort ────────────────────────────────────────
  // claude.ts derives the model from quality.tier at runtime (vendor.model is ignored).
  // vendor.model is written for codex only — api-key auth uses it as an override.
  if (!raw.quality || typeof raw.quality !== 'object') raw.quality = {}
  ;(raw.quality as Record<string, unknown>).tier = qualityTier
  const tierCfg = QUALITY_TIERS[qualityTier]
  vendors.claude.effort = tierCfg.claude.effort
  vendors.codex.model = tierCfg.codex.model
  vendors.codex.effort = tierCfg.codex.effort

  // ── Workflow pipeline ────────────────────────────────────────────────────────
  if (!raw.post_review || typeof raw.post_review !== 'object') raw.post_review = {}
  const postReview = raw.post_review as Record<string, unknown>
  if (!postReview.auto_fix || typeof postReview.auto_fix !== 'object') postReview.auto_fix = {}
  const autoFix = postReview.auto_fix as Record<string, unknown>
  if (pipelinePreset === 'review-only') {
    autoFix.enabled = false
  } else {
    autoFix.enabled = true
    autoFix.trigger = 'on_issues'
    if (!autoFix.delivery || typeof autoFix.delivery !== 'object') autoFix.delivery = {}
    const delivery = autoFix.delivery as Record<string, unknown>
    if (!delivery.mode) delivery.mode = 'commit'
  }

  writeFileSync(configPath, yaml.dump(raw, { lineWidth: -1, noRefs: true }))

  // ── Global workflow.yml ──────────────────────────────────────────────────────
  const globalWorkflowPath = join(workflowDir, 'workflow.yml')
  if (pipelinePreset === 'review-fix-recheck') {
    mkdirSync(workflowDir, { recursive: true })
    if (!existsSync(globalWorkflowPath)) {
      writeFileSync(globalWorkflowPath, WORKFLOW_RECHECK_YAML)
    }
    // If file already exists, preserve it — the user may have customized it
  } else if (existsSync(globalWorkflowPath)) {
    unlinkSync(globalWorkflowPath)
  }
}

export async function runOnboard(opts: OnboardOpts = {}) {
  if (!process.stdin.isTTY) {
    console.error(chalk.red('onboard requires an interactive terminal.'))
    console.error(chalk.dim('Run crosscheck init and edit crosscheck.config.yml manually.'))
    process.exit(1)
  }

  console.log(chalk.bold('\ncrosscheck onboard\n'))

  // ── Step 1: Auth check ─────────────────────────────────────────────────────
  console.log(chalk.bold('Step 1 — environment check'))
  const env = await checkEnv()
  if (!env.ok) process.exit(1)
  console.log()

  // ── Step 2: Deployment mode ────────────────────────────────────────────────
  console.log(chalk.bold('Step 2 — deployment mode'))
  const configPath = opts.config ?? resolveConfigPath() ?? join(homedir(), '.crosscheck', 'config.yml')
  const existingConfig = existsSync(configPath) ? loadConfig(configPath) : null
  const currentDeployment = existingConfig?.deployment

  let deployment: 'personal' | 'team'
  if (opts.personal) {
    deployment = 'personal'
    console.log(`  Mode: ${chalk.cyan('personal')} (--personal flag)`)
  } else if (opts.team) {
    deployment = 'team'
    console.log(`  Mode: ${chalk.cyan('team')} (--team flag)`)
  } else if (opts.yes && currentDeployment) {
    deployment = currentDeployment
    console.log(`  Mode: ${chalk.cyan(deployment)}`)
  } else {
    const deployItems: PickerItem[] = [
      { label: 'personal', description: 'monitor your own repos; review only your PRs' },
      { label: 'team', description: 'monitor org repos; review all PRs from any author' },
    ]
    const defaultDeployIdx = currentDeployment === 'team' ? 1 : 0
    const deployIdx = await promptSinglePicker(deployItems, {
      title: 'How are you using crosscheck?',
      defaultIndex: defaultDeployIdx,
    })
    deployment = deployIdx === 1 ? 'team' : 'personal'
  }
  console.log()

  // ── Step 3: Repo selection (hierarchical: namespace → repos) ───────────────
  console.log(chalk.bold('Step 3 — select repos to monitor'))

  let token: string
  try {
    token = getGithubToken()
  } catch (err: unknown) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)))
    process.exit(1)
  }

  const login = detectGitHubLogin() ?? ''
  console.log(chalk.dim(`  Fetching repos for ${login || 'your account'}...`))

  const [personalActivityRepos, orgs] = await Promise.all([
    login ? fetchActiveRepos(login, token).catch((): RepoActivity[] => []) : Promise.resolve<RepoActivity[]>([]),
    listUserOrgs(token).catch((): string[] => []),
  ])

  type OrgRepo = Awaited<ReturnType<typeof listOrgRepos>>[number]
  const orgRepoLists = await Promise.all(
    orgs.map(org => listOrgRepos(org, token).catch((): OrgRepo[] => []))
  )

  const currentRepoKeys = new Set(
    (existingConfig?.repos ?? []).map(r => `${r.owner}/${r.name}`)
  )
  const currentOrgs = new Set(existingConfig?.orgs ?? [])

  let selectedRepos: string[]
  let selectedOrgs: string[]

  if (opts.yes && existingConfig) {
    selectedRepos = [...currentRepoKeys]
    selectedOrgs = [...currentOrgs]
    console.log(`  Using existing repo selection (${selectedRepos.length} repos, ${selectedOrgs.length} orgs)`)
  } else {
    const totalRepos = personalActivityRepos.length + orgRepoLists.reduce((sum, l) => sum + l.length, 0)

    if (totalRepos === 0) {
      console.log(chalk.yellow('  No repos found. You can add repos manually in your config file.'))
      selectedRepos = []
      selectedOrgs = []
    } else {
      console.log()
      selectedRepos = []
      selectedOrgs = [...currentOrgs]

      // Build namespace list: personal account + each org
      const namespaces: string[] = []
      if (login && personalActivityRepos.length > 0) namespaces.push(login)
      for (const org of orgs) namespaces.push(org)

      let namespacesToBrowse: string[]

      if (namespaces.length <= 1) {
        // Only one namespace — skip group picker
        namespacesToBrowse = namespaces
      } else {
        // Step 3a: pick which namespaces to browse
        const nsDescriptions = new Map<string, string>()
        if (login) {
          const c = personalActivityRepos.length
          nsDescriptions.set(login, `personal · ${c} repo${c === 1 ? '' : 's'}`)
        }
        for (let i = 0; i < orgs.length; i++) {
          const c = orgRepoLists[i].length
          nsDescriptions.set(orgs[i], `org · ${c} repo${c === 1 ? '' : 's'}`)
        }

        // Pre-select namespaces that already have configured repos/orgs; default all on first run
        const currentNamespaces = new Set<string>()
        for (const key of currentRepoKeys) currentNamespaces.add(key.split('/')[0])
        for (const org of currentOrgs) currentNamespaces.add(org)
        const initialNs = currentNamespaces.size === 0
          ? namespaces
          : namespaces.filter(ns => currentNamespaces.has(ns))

        namespacesToBrowse = await promptRepoPicker(namespaces, {
          title: 'Which accounts do you want to browse?',
          initialSelected: initialNs,
          getDescription: (ns) => nsDescriptions.get(ns) ?? '',
          pageSize: Math.min(namespaces.length, 6),
        })
        console.log()
      }

      // Step 3b: for each selected namespace, show a focused repo picker
      for (const ns of namespacesToBrowse) {
        let repoKeys: string[]
        const descMap = new Map<string, string>()

        if (ns === login) {
          // Personal repos — already sorted by activity (tier 1 → tier 3, then pushedAt desc)
          repoKeys = personalActivityRepos.map(r => r.fullName)
          for (const r of personalActivityRepos) {
            descMap.set(r.fullName, formatAge(r.pushedAt))
          }
        } else {
          // Org repos — already sorted by pushedAt desc (sort=pushed in API call)
          const orgIdx = orgs.indexOf(ns)
          const orgRepos = orgIdx >= 0 ? orgRepoLists[orgIdx] : []
          repoKeys = orgRepos.map(r => `${r.owner}/${r.name}`)
          for (const r of orgRepos) {
            if (r.pushedAt) descMap.set(`${r.owner}/${r.name}`, formatAge(r.pushedAt))
          }
        }

        if (repoKeys.length === 0) continue

        const initialSel = repoKeys.filter(k => currentRepoKeys.has(k))

        const picked = await promptRepoPicker(repoKeys, {
          title: `Select repos from ${ns}:`,
          initialSelected: initialSel,
          getDescription: (key) => descMap.get(key) ?? '',
          pageSize: 5,
        })
        console.log()
        selectedRepos.push(...picked)
      }

      // Offer org-level monitoring when 3+ repos from the same org are selected
      const orgSet = new Set(orgs)
      const orgCounts: Record<string, number> = {}
      for (const r of selectedRepos) {
        const owner = r.split('/')[0]
        if (orgSet.has(owner)) orgCounts[owner] = (orgCounts[owner] ?? 0) + 1
      }
      const orgOffers = Object.entries(orgCounts)
        .filter(([, count]) => count >= 3)
        .map(([org]) => org)

      for (const org of orgOffers) {
        if (currentOrgs.has(org)) continue
        const answer = opts.yes ? 'n' : await ask(`  Monitor all of ${chalk.cyan(org)} instead of individual repos? [y/N]: `)
        if (answer.toLowerCase() === 'y') {
          selectedOrgs.push(org)
          selectedRepos = selectedRepos.filter(r => !r.startsWith(`${org}/`))
        }
      }
    }
  }
  console.log()

  // ── Step 4: Review mode (cross-vendor vs single-vendor) ───────────────────
  console.log(chalk.bold('Step 4 — review mode'))
  const vendorConfig = await promptVendorMode(
    env.claudeOk,
    env.codexOk,
    existingConfig?.mode,
    existingConfig?.vendors?.claude?.enabled ?? true,
    existingConfig?.vendors?.codex?.enabled ?? true,
    opts,
  )
  console.log()

  // ── Step 5: Review quality ────────────────────────────────────────────────
  console.log(chalk.bold('Step 5 — review quality'))
  const qualityTier = await promptQualityTier(
    vendorConfig.claudeEnabled,
    vendorConfig.codexEnabled,
    existingConfig?.quality?.tier,
    opts,
  )
  console.log()

  // ── Step 6: Workflow pipeline ──────────────────────────────────────────────
  console.log(chalk.bold('Step 6 — workflow pipeline'))
  const pipelinePreset = await promptWorkflowPipeline(
    existingConfig?.post_review?.auto_fix?.enabled,
    opts,
  )
  console.log()

  // ── Step 7: Connection type ────────────────────────────────────────────────
  console.log(chalk.bold('Step 7 — connection type'))
  const currentTunnel = existingConfig?.tunnel?.backend
  let tunnelBackend = await promptConnectionType(currentTunnel, opts)

  let smeeChannel = existingConfig?.tunnel?.smee_channel ?? ''
  if (tunnelBackend === 'smee') {
    if (smeeChannel) {
      console.log(`  smee channel ${chalk.cyan(smeeChannel)}`)
    } else if (!opts.yes) {
      console.log(chalk.dim('  Paste your smee.io channel URL below (leave blank to use localhost.run instead).\n'))
      const channel = await ask('  smee channel URL: ')
      if (channel) {
        smeeChannel = channel
      } else {
        tunnelBackend = 'localhost.run'
        console.log(chalk.yellow('  No channel provided — falling back to localhost.run.'))
      }
    } else {
      tunnelBackend = 'localhost.run'
      console.log(chalk.yellow('  smee selected but no channel configured — falling back to localhost.run.'))
      console.log(chalk.dim('  Set tunnel.smee_channel in config.yml and re-run onboard to use smee.io.'))
    }
  }
  console.log()

  // ── Step 8: Confirm and write ──────────────────────────────────────────────
  console.log(chalk.bold('Step 8 — review and write config'))
  console.log()
  console.log(`  deployment   ${chalk.cyan(deployment)}`)
  console.log(`  connection   ${chalk.cyan(tunnelBackend)}${tunnelBackend === 'smee' && smeeChannel ? chalk.dim(` (${smeeChannel})`) : ''}`)
  console.log(`  mode         ${chalk.cyan(vendorConfig.mode)}`)
  if (vendorConfig.mode === 'single-vendor') {
    const activeVendor = vendorConfig.claudeEnabled ? 'claude' : 'codex'
    console.log(`  vendor       ${chalk.cyan(activeVendor)}`)
  }
  console.log(`  quality      ${chalk.cyan(qualityTier)}${chalk.dim(`  — ${QUALITY_TIERS[qualityTier].description.split('  ')[0]}`)}`)
  console.log(`  pipeline     ${chalk.cyan(pipelinePreset)}`)
  if (selectedOrgs.length > 0) {
    console.log(`  orgs         ${selectedOrgs.map(o => chalk.cyan(o)).join(', ')}`)
  }
  if (selectedRepos.length > 0) {
    console.log(`  repos        ${selectedRepos.slice(0, 5).map(r => chalk.cyan(r)).join(', ')}${selectedRepos.length > 5 ? chalk.dim(` +${selectedRepos.length - 5} more`) : ''}`)
  }
  if (selectedOrgs.length === 0 && selectedRepos.length === 0) {
    console.log(`  ${chalk.yellow('No repos or orgs selected. Config will have empty scope.')}`)
  }
  console.log(`  config       ${chalk.dim(configPath)}`)
  if (pipelinePreset === 'review-fix-recheck') {
    const workflowPath = join(homedir(), '.crosscheck', 'workflow.yml')
    console.log(`  workflow     ${chalk.dim(workflowPath)}`)
  }
  console.log()

  if (!opts.yes) {
    const confirm = await ask(`  Write to config? [Y/n]: `)
    if (confirm.toLowerCase() === 'n') {
      console.log(chalk.dim('  Aborted — no changes written.'))
      return
    }
  }

  const globalWorkflowPath = join(homedir(), '.crosscheck', 'workflow.yml')
  const hadWorkflow = existsSync(globalWorkflowPath)

  applyOnboardConfig(configPath, {
    deployment,
    login,
    selectedRepos,
    selectedOrgs,
    vendorConfig,
    qualityTier,
    pipelinePreset,
    tunnelBackend,
    smeeChannel,
  })

  console.log(chalk.green(`  ✓ config written to ${configPath}`))
  if (pipelinePreset === 'review-fix-recheck') {
    if (!hadWorkflow) {
      console.log(chalk.green(`  ✓ workflow written to ${globalWorkflowPath}`))
    } else {
      console.log(chalk.dim(`  keeping existing workflow at ${globalWorkflowPath}`))
    }
  } else if (hadWorkflow) {
    console.log(chalk.dim(`  ✓ stale global workflow removed (pipeline changed to ${pipelinePreset})`))
  }

  console.log()

  // ── Next step hint ─────────────────────────────────────────────────────────
  console.log(chalk.dim('  Run crosscheck watch to start monitoring.\n'))
}
