import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createInterface } from 'readline'
import chalk from 'chalk'
import {
  loadConfig, resolveConfigPath, getGithubToken, detectGitHubLogin,
  writeOnboardConfig, type OnboardAnswers,
} from '../config/loader.js'
import { listUserOrgs, fetchActiveRepos } from '../github/client.js'
import { promptRepoPicker, promptOrgPicker } from '../lib/repo-picker.js'
import { runChecks } from './init.js'

export interface OnboardOpts {
  personal?: boolean
  team?: boolean
  reconfigure?: boolean
  config?: string
}

// ── Prompt helpers ────────────────────────────────────────────────────────────

async function ask(question: string): Promise<string> {
  if (!process.stdin.isTTY) return ''
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, answer => { rl.close(); resolve(answer.trim()) })
  })
}

// Print numbered choices and return the chosen 1-based index (defaultIdx if user presses Enter).
async function pickOne(prompt: string, options: string[], defaultIdx: number): Promise<number> {
  console.log(`\n${prompt}\n`)
  options.forEach(o => console.log(o))
  console.log()
  const answer = await ask(chalk.dim(`  Choice [${defaultIdx}]: `))
  const n = parseInt(answer, 10)
  return Number.isInteger(n) && n >= 1 && n <= options.length ? n : defaultIdx
}

async function confirmWrite(): Promise<boolean> {
  const answer = await ask('  Write config? [Y/n]: ')
  return answer === '' || /^y/i.test(answer)
}

async function confirmOptIn(question: string): Promise<boolean> {
  const answer = await ask(`${question} [y/N]: `)
  return /^y/i.test(answer)
}

// ── Fast-mode: skip all questions ────────────────────────────────────────────

async function runFastMode(
  deployment: 'personal' | 'team',
  configPath: string,
  login: string,
  orgs: string[],
): Promise<void> {
  const users = deployment === 'personal' && login ? [login] : []
  const allowedAuthors = deployment === 'personal' && login ? [login] : []
  const authorRoutes: Record<string, 'claude' | 'codex'> =
    deployment === 'personal' && login ? { [login]: 'claude' } : {}

  writeOnboardConfig(configPath, {
    deployment, login, orgs, users, repos: [],
    allowedAuthors, authorRoutes,
    autoFix: false, deliveryMode: 'pull_request',
    brand: { service_name: 'crosscheck', comment_header: '', comment_footer: '', reviewer_attribution: '' },
  })

  console.log(chalk.green(`\n  ✓ config written  (${deployment} mode, auto-detected scopes)\n`))
  if (orgs.length) console.log(`  ${'orgs'.padEnd(12)}${orgs.join(', ')}`)
  if (users.length) console.log(`  ${'users'.padEnd(12)}${users.join(', ')}`)
  console.log(chalk.dim(`\n  config  ${configPath}`))
  console.log(chalk.dim('  Run  crosscheck watch  to start.\n'))
}

// ── Branding step (shared by all personas) ────────────────────────────────────

async function askBranding(existingBrand?: {
  service_name?: string; comment_header?: string; comment_footer?: string; reviewer_attribution?: string
}): Promise<OnboardAnswers['brand']> {
  const brand = {
    service_name: existingBrand?.service_name ?? 'crosscheck',
    comment_header: existingBrand?.comment_header ?? '',
    comment_footer: existingBrand?.comment_footer ?? '',
    reviewer_attribution: existingBrand?.reviewer_attribution ?? '',
  }

  const wantBranding = await confirmOptIn(
    '\nAdd custom branding to review comments? (for teams, services, or personal flair)',
  )
  if (!wantBranding) return brand

  const name = await ask(`  Name or label shown in comments (${brand.service_name}): `)
  if (name) brand.service_name = name

  const header = await ask('  Comment header (prepended to every review, Enter to skip): ')
  brand.comment_header = header

  const footer = await ask('  Comment footer (appended to every review, Enter to skip): ')
  brand.comment_footer = footer

  const attr = await ask('  Reviewer attribution line (replaces "Reviewed by {vendor}", Enter to skip): ')
  brand.reviewer_attribution = attr

  return brand
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function runOnboard(opts: OnboardOpts): Promise<void> {
  console.log(chalk.bold('\ncrosscheck onboard\n'))

  // Resolve config path — prefer explicit, then project-local, then global default
  const configPath = resolveConfigPath(opts.config) ?? join(homedir(), '.crosscheck', 'config.yml')
  const hasFile = existsSync(configPath)
  const existing = hasFile ? loadConfig(configPath) : null

  // If already fully configured and user didn't request reconfigure or fast-mode, show summary
  if (hasFile && existing?.deployment && !opts.reconfigure && !opts.personal && !opts.team) {
    console.log(chalk.dim(`  Found existing config at ${configPath}\n`))
    console.log(`  ${'deployment'.padEnd(14)}${existing.deployment}`)
    if (existing.orgs.length) console.log(`  ${'orgs'.padEnd(14)}${existing.orgs.join(', ')}`)
    if (existing.users.length) console.log(`  ${'users'.padEnd(14)}${existing.users.join(', ')}`)
    if (existing.repos.length) console.log(`  ${'repos'.padEnd(14)}${existing.repos.length} configured`)
    console.log()
    console.log(chalk.dim('  Already configured. Run  crosscheck watch  to start.'))
    console.log(chalk.dim('  Use --reconfigure to change settings.\n'))
    return
  }

  // ── Step 0: Environment checks (compact) ──────────────────────────────────

  console.log(chalk.dim('Checking environment...\n'))
  const { results: checks } = await runChecks()
  for (const c of checks) {
    const icon = c.ok ? chalk.green('✓') : chalk.red('✗')
    const detail = c.ok ? chalk.dim(c.detail) : chalk.yellow(c.detail)
    console.log(`  ${icon} ${c.label.padEnd(22)} ${detail}`)
    if (!c.ok && c.fix) console.log(`      ${chalk.dim('→')} ${chalk.dim(c.fix)}`)
  }
  const failures = checks.filter(c => !c.ok && c.fix)
  console.log(
    failures.length === 0
      ? chalk.green('\n  ✓ environment ready — proceeding to setup\n')
      : chalk.yellow(`\n  ⚠ ${failures.length} issue(s) to address — see above; continuing setup\n`),
  )

  // ── Resolve GitHub identity ──────────────────────────────────────────────

  let token = ''
  let login = ''
  let detectedOrgs: string[] = []

  try {
    token = getGithubToken()
    login = detectGitHubLogin() ?? ''
    detectedOrgs = await listUserOrgs(token)
  } catch {
    console.log(chalk.dim('  (GitHub not authenticated — scope detection skipped)\n'))
  }

  // ── Fast mode: skip questionnaire, write immediately ─────────────────────

  if (opts.personal || opts.team) {
    const deployment = opts.personal ? 'personal' : 'team'
    mkdirSync(join(homedir(), '.crosscheck'), { recursive: true })
    await runFastMode(deployment, configPath, login, detectedOrgs)
    return
  }

  // ── Step 1: Persona ───────────────────────────────────────────────────────

  const currentPersonaDefault = existing?.deployment === 'team' ? 2 : 1
  const personaIdx = await pickOne('How will you use crosscheck?', [
    `  ${chalk.bold('[1] personal')}  — I author PRs; review only my own work across my repos and orgs`,
    `  ${chalk.bold('[2] team')}      — shared CR workflow; review PRs from multiple authors in org repos`,
  ], currentPersonaDefault)
  const deployment: 'personal' | 'team' = personaIdx === 2 ? 'team' : 'personal'

  let orgs: string[] = []
  let users: string[] = []
  let repos: Array<{ owner: string; name: string }> = []
  let allowedAuthors: string[] = []
  let authorRoutes: Record<string, 'claude' | 'codex'> = {}
  let autoFix = false
  let deliveryMode: 'pull_request' | 'commit' = 'pull_request'

  // ── Personal path ─────────────────────────────────────────────────────────

  if (deployment === 'personal') {

    // Step 2: Scope
    const orgPreview = detectedOrgs.slice(0, 2).map(o => `github.com/${o}/*`).join(', ') || 'your org repos'
    const orgSuffix = detectedOrgs.length ? `  (detected: ${detectedOrgs.join(', ')})` : ''
    const existingScope = existing
      ? (existing.users.length > 0 && existing.orgs.length > 0 ? 3
        : existing.users.length > 0 ? 1
        : existing.orgs.length > 0 ? 2 : 3)
      : 3

    const scopeIdx = await pickOne(`What should crosscheck monitor?${orgSuffix}`, [
      `  ${chalk.bold('[1] My personal repos only')}     — github.com/${login || 'you'}/* — side projects you own directly`,
      `  ${chalk.bold('[2] My org repos only')}          — ${orgPreview}`,
      `  ${chalk.bold('[3] Both personal repos + orgs')} — everything across your GitHub account  ← recommended`,
    ], existingScope)

    const includePersonal = scopeIdx !== 2
    const includeOrgs = scopeIdx !== 1

    if (includeOrgs && detectedOrgs.length > 0) {
      orgs = await promptOrgPicker(detectedOrgs, existing?.orgs.length ? existing.orgs : undefined)
    }

    if (includePersonal && token && login) {
      if (scopeIdx === 1) {
        // Curated mode (UC-01): pick specific repos
        console.log(chalk.dim('\n  Fetching your repos...'))
        try {
          const repoList = await fetchActiveRepos(login, token)
          const existingNames = existing?.repos.map(r => `${r.owner}/${r.name}`) ?? []
          const picked = await promptRepoPicker(repoList, existingNames.length ? existingNames : undefined)
          repos = picked.map(full => {
            const [owner, name] = full.split('/')
            return { owner: owner ?? login, name: name ?? full }
          })
        } catch {
          console.log(chalk.dim('  (Could not fetch repos — add them manually to config.repos)\n'))
        }
      } else {
        // "Both" mode (UC-02): monitor all personal repos via users field
        users = [login]
      }
    } else if (includePersonal) {
      users = login ? [login] : []
    }

    // Step 3: Author filter
    const currentFilterDefault = existing?.routing?.allowed_authors?.length === 0 ? 2 : 1
    const filterIdx = await pickOne('Whose PRs should be reviewed?', [
      `  ${chalk.bold('[1] Only mine')}   (author = ${login || 'you'})    ← recommended`,
      `  ${chalk.bold('[2] Everyone')} in the monitored scope`,
    ], currentFilterDefault)

    if (filterIdx === 1 && login) {
      allowedAuthors = [login]
      authorRoutes = { [login]: 'claude' }
    }

  // ── Team path ─────────────────────────────────────────────────────────────

  } else {

    // Step 2: Org picker
    if (detectedOrgs.length > 0) {
      orgs = await promptOrgPicker(detectedOrgs, existing?.orgs.length ? existing.orgs : undefined)
    } else {
      const manual = await ask('  Enter org names (comma-separated, or Enter to skip): ')
      orgs = manual ? manual.split(',').map(s => s.trim()).filter(Boolean) : []
    }

    // Step 3: Author filter
    const authorIdx = await pickOne('Whose PRs should be reviewed?', [
      `  ${chalk.bold('[1] All authors')} (no filter) — review every PR in the org`,
      `  ${chalk.bold('[2] Specific logins')}  — restrict to listed team members`,
    ], 1)

    if (authorIdx === 2) {
      const raw = await ask('  Enter logins (comma-separated): ')
      allowedAuthors = raw.split(',').map(s => s.trim()).filter(Boolean)
    }

    // Step 4: Review depth
    const depthIdx = await pickOne('How deep should the CR workflow go?', [
      `  ${chalk.bold('[1] CR only')}       — post review comments; humans apply fixes`,
      `  ${chalk.bold('[2] CR + Auto-fix')} — crosscheck also proposes and commits fixes`,
    ], 1)

    if (depthIdx === 2) {
      autoFix = true
      const deliveryIdx = await pickOne('How should auto-fixes be delivered?', [
        `  ${chalk.bold('[1] Open a fix PR')}   (human reviews and merges before merge)   ← recommended`,
        `  ${chalk.bold('[2] Push directly')} onto the PR branch`,
      ], 1)
      deliveryMode = deliveryIdx === 2 ? 'commit' : 'pull_request'
    }
  }

  // ── Optional branding (all paths) ─────────────────────────────────────────

  const brand = await askBranding(existing?.brand)

  // ── Confirmation preview ──────────────────────────────────────────────────

  const COL = 14
  console.log(chalk.bold('\n  Your crosscheck config:\n'))
  console.log(`    ${'persona'.padEnd(COL)}${deployment}`)
  if (orgs.length) console.log(`    ${'orgs'.padEnd(COL)}${orgs.join(', ')}`)
  if (users.length) console.log(`    ${'users'.padEnd(COL)}${users.join(', ')}`)
  if (repos.length) console.log(`    ${'repos'.padEnd(COL)}${repos.map(r => `${r.owner}/${r.name}`).join(', ')}`)
  console.log(
    `    ${'filter'.padEnd(COL)}${allowedAuthors.length ? `author = ${allowedAuthors.join(', ')}` : 'all authors'}`,
  )
  if (autoFix) console.log(`    ${'auto-fix'.padEnd(COL)}${deliveryMode}`)
  if (brand.service_name !== 'crosscheck') console.log(`    ${'brand'.padEnd(COL)}${brand.service_name}`)
  console.log(`    ${'config'.padEnd(COL)}${configPath}`)
  console.log()

  const ok = await confirmWrite()
  if (!ok) {
    console.log(chalk.dim('  Cancelled. No files written.\n'))
    return
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  writeOnboardConfig(configPath, {
    deployment, login, orgs, users, repos,
    allowedAuthors, authorRoutes,
    autoFix, deliveryMode, brand,
  })

  console.log(chalk.green(`\n  ✓ config written → ${configPath}`))
  console.log(chalk.dim('  Run  crosscheck watch  to start.\n'))
}
