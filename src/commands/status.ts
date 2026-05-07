import { execSync } from 'child_process'
import chalk from 'chalk'
import { loadConfig } from '../config/loader.js'
import { checkCodexAuth } from '../reviewers/codex.js'
import { checkClaudeAuth } from '../reviewers/claude.js'

function row(label: string, value: string, ok?: boolean) {
  const indicator = ok === undefined ? ' ' : ok ? chalk.green('✓') : chalk.red('✗')
  console.log(`  ${indicator} ${chalk.bold(label.padEnd(22))} ${value}`)
}

export async function runStatus(configPath?: string) {
  const config = loadConfig(configPath)

  console.log(chalk.bold('\ncrosscheck status\n'))

  // Auth
  console.log(chalk.dim('  Auth'))
  const [codexAuth, claudeAuth] = await Promise.all([checkCodexAuth(), checkClaudeAuth()])
  row('codex', codexAuth.detail || 'authenticated', codexAuth.ok)
  row('claude', claudeAuth.detail || 'authenticated', claudeAuth.ok)

  const ghToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  row('GITHUB_TOKEN', ghToken ? 'set' : 'missing', !!ghToken)

  const webhookSecret = process.env.CROSSCHECK_WEBHOOK_SECRET ?? process.env.GITHUB_WEBHOOK_SECRET
  row('WEBHOOK_SECRET', webhookSecret ? 'set' : 'missing (needed for serve/watch)', !!webhookSecret)

  // Config
  console.log()
  console.log(chalk.dim('  Config'))
  row('mode', config.mode)
  row('quality tier', config.quality.tier)
  row('codex auth', config.vendors.codex.auth)
  row('claude model', config.vendors.claude.model ?? 'default')
  row('per-review budget', config.vendors.codex.auth === 'subscription'
    ? 'subscription (unlimited)'
    : `$${config.budget.per_review_usd.toFixed(2)}`)

  if (config.repos.length > 0) {
    row('repos', config.repos.map(r => `${r.owner}/${r.name}`).join(', '))
  }

  if (config.quality.focus.length > 0) {
    row('focus', config.quality.focus.join(', '))
  }

  // CLI versions
  console.log()
  console.log(chalk.dim('  CLIs'))
  try {
    const codexVer = execSync('codex --version 2>&1', { encoding: 'utf8' }).trim()
    row('codex', codexVer)
  } catch {
    row('codex', 'not found', false)
  }
  try {
    const claudeVer = execSync('claude --version 2>&1', { encoding: 'utf8' }).trim()
    row('claude', claudeVer)
  } catch {
    row('claude', 'not found', false)
  }

  console.log()
}
