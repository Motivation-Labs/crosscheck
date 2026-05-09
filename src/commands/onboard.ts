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
  promptDeploymentMode,
  patchDeploymentConfig,
} from '../config/loader.js'
import { listUserRepos, listUserOrgs, listOrgRepos } from '../github/client.js'
import { checkCodexAuth } from '../reviewers/codex.js'
import { checkClaudeAuth } from '../reviewers/claude.js'
import { execSync } from 'child_process'
import { promptRepoPicker } from '../lib/repo-picker.js'

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

function ask(question: string): Promise<string> {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, answer => { rl.close(); resolve(answer.trim()) })
  })
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
  currentMode: string | undefined,
  currentClaudeEnabled: boolean,
  currentCodexEnabled: boolean,
  opts: OnboardOpts,
): Promise<VendorModeConfig> {
  const bothAvailable = claudeOk && codexOk

  if (!bothAvailable) {
    // Only one CLI is available — auto-select single-vendor
    const vendor = claudeOk ? 'claude' : 'codex'
    console.log(`  Mode: ${chalk.cyan('single-vendor')} (only ${chalk.bold(vendor)} is available)`)
    return { mode: 'single-vendor', claudeEnabled: claudeOk, codexEnabled: codexOk }
  }

  if (opts.yes && currentMode) {
    console.log(`  Using existing mode: ${chalk.cyan(currentMode)}`)
    return {
      mode: currentMode as 'cross-vendor' | 'single-vendor',
      claudeEnabled: currentClaudeEnabled,
      codexEnabled: currentCodexEnabled,
    }
  }

  if (currentMode && !opts.yes) {
    const keep = await ask(`  Current mode: ${chalk.cyan(currentMode)}. Keep this? [Y/n]: `)
    if (keep.toLowerCase() !== 'n') {
      return {
        mode: currentMode as 'cross-vendor' | 'single-vendor',
        claudeEnabled: currentClaudeEnabled,
        codexEnabled: currentCodexEnabled,
      }
    }
    console.log()
  }

  console.log('  How should reviews be assigned?\n')
  console.log(`  [1] cross-vendor   — ${chalk.dim('Claude reviews Codex PRs; Codex reviews Claude PRs')}`)
  console.log(`  [2] single-vendor  — ${chalk.dim('one AI reviews all PRs')}`)
  console.log()
  const choice = await ask('  Choice [1]: ')
  console.log()

  if (choice === '2') {
    console.log('  Which AI should review all PRs?\n')
    console.log(`  [1] claude`)
    console.log(`  [2] codex`)
    console.log()
    const vendorChoice = await ask('  Choice [1]: ')
    console.log()
    const vendor = vendorChoice === '2' ? 'codex' : 'claude'
    return {
      mode: 'single-vendor',
      claudeEnabled: vendor === 'claude',
      codexEnabled: vendor === 'codex',
    }
  }

  return { mode: 'cross-vendor', claudeEnabled: true, codexEnabled: true }
}

async function promptWorkflowPipeline(
  currentAutoFixEnabled: boolean | undefined,
  opts: OnboardOpts,
): Promise<WorkflowPreset> {
  if (opts.yes) {
    const preset: WorkflowPreset = currentAutoFixEnabled === true ? 'review-fix' : 'review-only'
    console.log(`  Using existing pipeline: ${chalk.cyan(preset)}`)
    return preset
  }

  console.log('  What should happen after a review?\n')
  console.log(`  [1] review only              — ${chalk.dim('AI posts a comment; you handle fixes')}`)
  console.log(`  [2] review → fix             — ${chalk.dim('AI reviews, then auto-applies fixes')}  ${chalk.green('(recommended)')}`)
  console.log(`  [3] review → fix → re-check  — ${chalk.dim('full loop: review, fix, re-review to confirm')}`)
  console.log()
  const choice = await ask('  Choice [2]: ')
  console.log()

  if (choice === '1') return 'review-only'
  if (choice === '3') return 'review-fix-recheck'
  return 'review-fix'
}

async function promptConnectionType(current?: 'localhost.run' | 'smee'): Promise<'localhost.run' | 'smee'> {
  return new Promise<'localhost.run' | 'smee'>(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    console.log('  How will GitHub reach your crosscheck server?\n')
    console.log(`  [1] localhost.run  — ${chalk.dim('zero-config SSH tunnel; reconnects automatically, no install required')}`)
    console.log(`  [2] smee.io        — ${chalk.dim('webhook relay; events queued while offline, stable channel URL')}`)
    if (current) console.log(`\n  Current: ${current}`)
    console.log()
    rl.question('  Choice [1]: ', (answer) => {
      rl.close()
      resolve(answer.trim() === '2' ? 'smee' : 'localhost.run')
    })
  })
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
  } else if (currentDeployment && !opts.yes) {
    const keep = await ask(`  Current mode: ${chalk.cyan(currentDeployment)}. Keep this? [Y/n]: `)
    deployment = keep.toLowerCase() === 'n' ? await promptDeploymentMode() : currentDeployment
  } else if (currentDeployment && opts.yes) {
    deployment = currentDeployment
    console.log(`  Using existing mode: ${chalk.cyan(deployment)}`)
  } else {
    deployment = await promptDeploymentMode()
  }
  console.log()

  // ── Step 3: Repo selection ─────────────────────────────────────────────────
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

  const [personalRepos, orgs] = await Promise.all([
    login ? listUserRepos(login, token, true).catch(() => []) : Promise.resolve([]),
    listUserOrgs(token).catch(() => []),
  ])

  const orgRepoLists = await Promise.all(
    orgs.map(org => listOrgRepos(org, token).catch(() => []))
  )

  const allRepos: string[] = []
  for (const r of personalRepos) allRepos.push(`${r.owner}/${r.name}`)
  for (let i = 0; i < orgs.length; i++) {
    for (const r of orgRepoLists[i]) allRepos.push(`${r.owner}/${r.name}`)
  }

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
    if (allRepos.length === 0) {
      console.log(chalk.yellow('  No repos found. You can add repos manually in your config file.'))
      selectedRepos = []
      selectedOrgs = []
    } else {
      const sorted = [
        ...allRepos.filter(r => currentRepoKeys.has(r)),
        ...allRepos.filter(r => !currentRepoKeys.has(r)),
      ]

      console.log(chalk.dim(`  Found ${sorted.length} repos. Use arrows + space to select, enter to confirm.\n`))
      const picked = await promptRepoPicker(sorted, {
        title: 'Select repos to monitor:',
        initialSelected: [...currentRepoKeys],
      })
      console.log()

      const orgSet = new Set(orgs)
      const orgCounts: Record<string, number> = {}
      for (const r of picked) {
        const owner = r.split('/')[0]
        if (orgSet.has(owner)) orgCounts[owner] = (orgCounts[owner] ?? 0) + 1
      }
      const orgOffers = Object.entries(orgCounts).filter(([, count]) => count >= 3).map(([org]) => org)

      selectedOrgs = [...currentOrgs]
      selectedRepos = picked

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

  // ── Step 5: Workflow pipeline ──────────────────────────────────────────────
  console.log(chalk.bold('Step 5 — workflow pipeline'))
  const pipelinePreset = await promptWorkflowPipeline(
    existingConfig?.post_review?.auto_fix?.enabled,
    opts,
  )
  console.log()

  // ── Step 6: Connection type ────────────────────────────────────────────────
  console.log(chalk.bold('Step 6 — connection type'))
  const currentTunnel = existingConfig?.tunnel?.backend

  let tunnelBackend: 'localhost.run' | 'smee'
  if (opts.yes && currentTunnel) {
    tunnelBackend = currentTunnel
    console.log(`  Using existing connection type: ${chalk.cyan(tunnelBackend)}`)
  } else if (currentTunnel && !opts.yes) {
    const keep = await ask(`  Current: ${chalk.cyan(currentTunnel)}. Keep this? [Y/n]: `)
    tunnelBackend = keep.toLowerCase() === 'n' ? await promptConnectionType(currentTunnel) : currentTunnel
  } else {
    tunnelBackend = await promptConnectionType()
  }

  if (tunnelBackend === 'smee' && !(existingConfig?.tunnel?.smee_channel)) {
    console.log(chalk.dim('  → Install smee client: npm install -g smee-client'))
    console.log(chalk.dim('  → Create a channel at https://smee.io, then set tunnel.smee_channel in your config.'))
  }
  console.log()

  // ── Step 7: Confirm and write ──────────────────────────────────────────────
  console.log(chalk.bold('Step 7 — review and write config'))
  console.log()
  console.log(`  deployment   ${chalk.cyan(deployment)}`)
  console.log(`  connection   ${chalk.cyan(tunnelBackend)}`)
  console.log(`  mode         ${chalk.cyan(vendorConfig.mode)}`)
  if (vendorConfig.mode === 'single-vendor') {
    const activeVendor = vendorConfig.claudeEnabled ? 'claude' : 'codex'
    console.log(`  vendor       ${chalk.cyan(activeVendor)}`)
  }
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

  mkdirSync(dirname(configPath), { recursive: true })
  patchDeploymentConfig(configPath, deployment, login, selectedOrgs, true)

  // Patch all fields after deployment config is written
  const raw = (yaml.load(readFileSync(configPath, 'utf8')) ?? {}) as Record<string, unknown>

  // Connection type
  if (!raw.tunnel || typeof raw.tunnel !== 'object') raw.tunnel = {}
  ;(raw.tunnel as Record<string, unknown>).backend = tunnelBackend

  // Repos
  raw.repos = selectedRepos.map(r => {
    const [owner, name] = r.split('/')
    return { owner, name }
  })
  if (selectedRepos.length > 0 || selectedOrgs.length > 0) delete raw.users

  // Vendor mode
  raw.mode = vendorConfig.mode
  if (!raw.vendors || typeof raw.vendors !== 'object') raw.vendors = {}
  const vendors = raw.vendors as Record<string, Record<string, unknown>>
  if (!vendors.claude) vendors.claude = {}
  if (!vendors.codex) vendors.codex = {}
  vendors.claude.enabled = vendorConfig.claudeEnabled
  vendors.codex.enabled = vendorConfig.codexEnabled

  // Workflow pipeline
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
  console.log(chalk.green(`  ✓ config written to ${configPath}`))

  // Manage global workflow.yml — write for recheck preset, remove stale file otherwise
  const globalWorkflowPath = join(homedir(), '.crosscheck', 'workflow.yml')
  if (pipelinePreset === 'review-fix-recheck') {
    mkdirSync(join(homedir(), '.crosscheck'), { recursive: true })
    writeFileSync(globalWorkflowPath, WORKFLOW_RECHECK_YAML)
    console.log(chalk.green(`  ✓ workflow written to ${globalWorkflowPath}`))
  } else if (existsSync(globalWorkflowPath)) {
    unlinkSync(globalWorkflowPath)
    console.log(chalk.dim(`  ✓ stale global workflow removed (pipeline changed to ${pipelinePreset})`))
  }

  console.log()

  // ── Step 8: Next step hint ────────────────────────────────────────────────
  console.log(chalk.dim('  Run crosscheck watch to start monitoring.\n'))
}
