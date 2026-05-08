import { execSync } from 'child_process'
import { existsSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import chalk from 'chalk'
import { checkCodexAuth } from '../reviewers/codex.js'
import { checkClaudeAuth } from '../reviewers/claude.js'
import { getWebhookSecret, getWebhookSecretPath } from '../config/loader.js'

interface CheckResult {
  label: string
  ok: boolean
  detail: string
  fix?: string
}

async function runChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = []

  // Check codex CLI
  try {
    const version = execSync('codex --version 2>&1', { encoding: 'utf8' }).trim()
    const auth = await checkCodexAuth()
    results.push({ label: 'codex CLI', ok: auth.ok, detail: `${version} — ${auth.detail}`, fix: auth.ok ? undefined : 'Run: codex login --device-auth' })
  } catch {
    results.push({ label: 'codex CLI', ok: false, detail: 'not found', fix: 'Install: npm install -g @openai/codex' })
  }

  // Check claude CLI
  try {
    const auth = await checkClaudeAuth()
    results.push({ label: 'claude CLI', ok: auth.ok, detail: auth.detail, fix: auth.ok ? undefined : 'Run: claude auth login' })
  } catch {
    results.push({ label: 'claude CLI', ok: false, detail: 'not found', fix: 'Install: npm install -g @anthropic-ai/claude-code' })
  }

  // Check gh CLI — authenticated if stored credentials OR GITHUB_TOKEN env var is set
  const envToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  let ghAuthed = false
  try {
    const version = execSync('gh --version 2>&1', { encoding: 'utf8' }).split('\n')[0]
    // gh auth status exits non-zero when GITHUB_TOKEN env var is set — handle separately
    let authOutput = ''
    try { authOutput = execSync('gh auth status 2>&1', { encoding: 'utf8' }) } catch { /* GITHUB_TOKEN in use */ }
    const keyringAuthed = authOutput.includes('Logged in')
    ghAuthed = keyringAuthed || !!envToken
    const detail = !!envToken && !keyringAuthed
      ? `${version} — authenticated via GITHUB_TOKEN`
      : version
    results.push({ label: 'gh CLI', ok: ghAuthed, detail, fix: ghAuthed ? undefined : 'Run: gh auth login' })
  } catch {
    results.push({ label: 'gh CLI', ok: false, detail: 'not found', fix: 'Install: brew install gh && gh auth login' })
  }
  // Token is resolvable if env var is set OR if gh keyring has a token (getGithubToken() falls back to `gh auth token`)
  const tokenResolvable = !!envToken || ghAuthed
  const tokenDetail = envToken ? 'set via env' : ghAuthed ? 'via gh auth login' : 'missing'
  results.push({ label: 'GITHUB_TOKEN', ok: tokenResolvable, detail: tokenDetail, fix: tokenResolvable ? undefined : 'Set GITHUB_TOKEN or run: gh auth login' })

  // Check admin:org_hook scope — needed for org-level webhook registration in watch/serve
  if (ghAuthed) {
    try {
      const statusOutput = execSync('gh auth status 2>&1', {
        encoding: 'utf8',
        env: { ...process.env, GITHUB_TOKEN: undefined, GH_TOKEN: undefined },
      })
      const scopeMatch = statusOutput.match(/Token scopes:\s*(.+)/)
      if (scopeMatch) {
        const scopes = scopeMatch[1]
        const hasOrgHook = /admin:org_hook|'admin:org'|"admin:org"/.test(scopes)
        results.push({
          label: 'org webhook scope',
          ok: hasOrgHook,
          detail: hasOrgHook ? 'admin:org_hook present' : `not granted (scopes: ${scopes.trim()})`,
          fix: hasOrgHook ? undefined : 'gh auth refresh -s admin:org_hook  (required for org-level webhooks)',
        })
      }
    } catch { /* gh not available or scope line absent — skip silently */ }
  }

  // Check WEBHOOK_SECRET — auto-generated if missing, so always ok
  const fromEnv = process.env.CROSSCHECK_WEBHOOK_SECRET ?? process.env.GITHUB_WEBHOOK_SECRET
  const secretDetail = fromEnv
    ? 'set via env'
    : `auto-managed at ${getWebhookSecretPath()}`
  getWebhookSecret() // ensure it's generated/persisted
  results.push({ label: 'WEBHOOK_SECRET', ok: true, detail: secretDetail })

  return results
}

function printCheck({ label, ok, detail, fix }: CheckResult) {
  const icon = ok ? chalk.green('✓') : chalk.red('✗')
  const labelStr = chalk.bold(label.padEnd(20))
  console.log(`  ${icon} ${labelStr} ${detail}`)
  if (!ok && fix) console.log(`      ${chalk.dim('→')} ${chalk.yellow(fix)}`)
}

export async function runInit(configPath?: string) {
  console.log(chalk.bold('\ncrosscheck — environment check\n'))

  const checks = await runChecks()
  for (const check of checks) printCheck(check)

  const failures = checks.filter(c => !c.ok && c.fix)
  if (failures.length > 0) {
    console.log(chalk.yellow(`\n${failures.length} issue(s) need attention before crosscheck can run fully.\n`))
  } else {
    console.log(chalk.green('\nAll checks passed.\n'))
  }

  // Write example config if none exists
  const dest = configPath ?? join(process.cwd(), 'crosscheck.config.yml')
  if (!existsSync(dest)) {
    const examplePath = new URL('../../crosscheck.config.example.yml', import.meta.url).pathname
    if (existsSync(examplePath)) {
      writeFileSync(dest, readFileSync(examplePath))
      console.log(chalk.dim(`Config written to ${dest} — edit to customize.\n`))
    }
  } else {
    console.log(chalk.dim(`Config already exists at ${dest}\n`))
  }
}
