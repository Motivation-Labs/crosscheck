import { execSync } from 'child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import chalk from 'chalk'
import { checkCodexAuth } from '../reviewers/codex.js'
import { checkClaudeAuth } from '../reviewers/claude.js'

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

  // Check gh CLI
  try {
    const version = execSync('gh --version 2>&1', { encoding: 'utf8' }).split('\n')[0]
    const auth = execSync('gh auth status 2>&1', { encoding: 'utf8' })
    results.push({ label: 'gh CLI', ok: auth.includes('Logged in'), detail: version })
  } catch {
    results.push({ label: 'gh CLI', ok: false, detail: 'not found or not authed', fix: 'Install: brew install gh && gh auth login' })
  }

  // Check GITHUB_TOKEN
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  results.push({ label: 'GITHUB_TOKEN', ok: !!token, detail: token ? 'set' : 'missing', fix: 'Set GITHUB_TOKEN in your shell profile' })

  // Check CROSSCHECK_WEBHOOK_SECRET
  const secret = process.env.CROSSCHECK_WEBHOOK_SECRET ?? process.env.GITHUB_WEBHOOK_SECRET
  results.push({ label: 'WEBHOOK_SECRET', ok: !!secret, detail: secret ? 'set' : 'missing (only needed for serve/watch)', fix: 'Set CROSSCHECK_WEBHOOK_SECRET' })

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
