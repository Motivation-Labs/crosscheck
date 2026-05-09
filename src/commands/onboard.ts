import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
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
}

function ask(question: string): Promise<string> {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, answer => { rl.close(); resolve(answer.trim()) })
  })
}

async function checkEnv(): Promise<boolean> {
  let aiCliCount = 0

  try {
    execSync('codex --version 2>&1', { encoding: 'utf8' })
    const auth = await checkCodexAuth()
    if (auth.ok) aiCliCount++
    const icon = auth.ok ? chalk.green('✓') : chalk.red('✗')
    console.log(`  ${icon} ${'codex CLI'.padEnd(20)} ${auth.detail}`)
    if (!auth.ok) console.log(`      ${chalk.dim('→')} ${chalk.yellow('Run: codex login --device-auth')}`)
  } catch {
    console.log(`  ${chalk.red('✗')} ${'codex CLI'.padEnd(20)} not found`)
    console.log(`      ${chalk.dim('→')} ${chalk.yellow('Install: npm install -g @openai/codex')}`)
  }

  try {
    const auth = await checkClaudeAuth()
    if (auth.ok) aiCliCount++
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

  if (aiCliCount === 0) {
    console.log(chalk.red('\nAt least one AI CLI (codex or claude) must be authenticated.\n'))
    return false
  }
  if (!ghAuthed) {
    console.log(chalk.red('\nGitHub auth is required to fetch repos and register webhooks.\n'))
    return false
  }
  return true
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
  const ok = await checkEnv()
  if (!ok) process.exit(1)
  console.log()

  // ── Step 2: Deployment mode ────────────────────────────────────────────────
  console.log(chalk.bold('Step 2 — deployment mode'))
  const configPath = opts.config ?? resolveConfigPath() ?? join(homedir(), '.crosscheck', 'config.yml')
  const existingConfig = existsSync(configPath) ? loadConfig(configPath) : null
  const currentDeployment = existingConfig?.deployment

  let deployment: 'personal' | 'team'
  if (currentDeployment && !opts.yes) {
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

  // Fetch personal repos and org repos in parallel
  const [personalRepos, orgs] = await Promise.all([
    login ? listUserRepos(login, token, true).catch(() => []) : Promise.resolve([]),
    listUserOrgs(token).catch(() => []),
  ])

  const orgRepoLists = await Promise.all(
    orgs.map(org => listOrgRepos(org, token).catch(() => []))
  )

  // Build flat list of "owner/repo" strings for the picker
  const allRepos: string[] = []
  for (const r of personalRepos) allRepos.push(`${r.owner}/${r.name}`)
  for (let i = 0; i < orgs.length; i++) {
    for (const r of orgRepoLists[i]) allRepos.push(`${r.owner}/${r.name}`)
  }

  // Pre-select repos already in config
  const currentRepoKeys = new Set(
    (existingConfig?.repos ?? []).map(r => `${r.owner}/${r.name}`)
  )
  const currentOrgs = new Set(existingConfig?.orgs ?? [])

  // If running with --yes, keep existing selection
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
      // Pre-mark already-configured repos as selected via a sorted list
      // where configured repos appear first
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

      // Check org offer: if ≥3 repos from the same real org, offer to monitor the entire org.
      // Only count owners that appear in the fetched org list — excludes the personal login.
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

  // ── Step 4: Confirm and write ──────────────────────────────────────────────
  console.log(chalk.bold('Step 4 — review and write config'))
  console.log()
  console.log(`  deployment   ${chalk.cyan(deployment)}`)
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
  console.log()

  if (!opts.yes) {
    const confirm = await ask(`  Write to config? [Y/n]: `)
    if (confirm.toLowerCase() === 'n') {
      console.log(chalk.dim('  Aborted — no changes written.'))
      return
    }
  }

  mkdirSync(dirname(configPath), { recursive: true })
  // patchDeploymentConfig handles deployment, orgs, users, allowed_authors, author_routes
  patchDeploymentConfig(configPath, deployment, login, selectedOrgs, true)

  // Patch repos after — load the file written by patchDeploymentConfig and add repos
  const raw = (yaml.load(readFileSync(configPath, 'utf8')) ?? {}) as Record<string, unknown>
  raw.repos = selectedRepos.map(r => {
    const [owner, name] = r.split('/')
    return { owner, name }
  })
  // Explicit repo selections take precedence over the `users` expansion in watch/serve.
  // Clear `users` so watch doesn't expand to every repo owned by the login in addition to `repos`.
  if (selectedRepos.length > 0) delete raw.users
  writeFileSync(configPath, yaml.dump(raw, { lineWidth: -1, noRefs: true }))

  console.log(chalk.green(`  ✓ config written to ${configPath}`))
  console.log()

  // ── Step 5: Next step hint ────────────────────────────────────────────────
  console.log(chalk.dim('  Run crosscheck watch to start monitoring.\n'))
}
