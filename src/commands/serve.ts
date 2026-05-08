import { mkdtempSync, rmSync } from 'fs'
import { tmpdir, hostname } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'
import chalk from 'chalk'
import { createWebhookServer, type PREvent } from '../github/webhook.js'
import { detectPROrigin, assignReviewer } from '../github/detector.js'
import { loadConfig, getGithubToken, getWebhookSecret } from '../config/loader.js'
import { randomFortune } from '../lib/fortune.js'
import { initLogger, log as fileLog, logError, logUncaught } from '../lib/logger.js'
import { runWorkflow } from '../lib/runner.js'

// Deduplication — keyed by owner/repo#pr@sha
const inFlight = new Set<string>()
// SHAs pushed by the address step — skip synchronize events from our own commits
const crosscheckShas = new Set<string>()

async function handlePR(event: PREvent, config: ReturnType<typeof loadConfig>, token: string, log: (msg: string) => void) {
  const { pull_request: pr, repository: repo } = event
  const owner = repo.owner.login
  const repoName = repo.name
  const prNumber = event.number
  const key = `${owner}/${repoName}#${prNumber}@${pr.head.sha}`

  if (inFlight.has(key)) {
    log(`PR #${prNumber} already in review — skipping duplicate event`)
    return
  }

  // Skip synchronize events triggered by our own address commits
  if (crosscheckShas.has(pr.head.sha)) {
    fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'crosscheck_sha', sha: pr.head.sha })
    return
  }

  inFlight.add(key)

  const author = pr.user.login
  const allowedAuthors = config.routing.allowed_authors
  if (allowedAuthors.length > 0 && !allowedAuthors.includes(author)) {
    fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'author_not_allowed', author })
    inFlight.delete(key)
    return
  }

  log(`PR #${prNumber} ${event.action}: ${pr.title}`)

  const origin = detectPROrigin(pr.body ?? '', config)
  const reviewer = assignReviewer(origin, config)

  fileLog({ level: 'info', event: 'pr_received', repo: `${owner}/${repoName}`, pr: prNumber, sha: pr.head.sha, action: event.action, origin, author })

  if (!reviewer) {
    log(`  → origin=${origin}, no reviewer — skipping`)
    inFlight.delete(key)
    return
  }

  log(`  → origin=${origin}, reviewer=${reviewer}`)

  const tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-repo-'))
  const reviewStart = Date.now()
  try {
    log('  → cloning...')
    execSync(`gh repo clone ${owner}/${repoName} ${tmpDir} -- --depth=50 --quiet`, { stdio: 'pipe', env: { ...process.env, GITHUB_TOKEN: token, GH_TOKEN: token } })
    execSync(`git fetch origin pull/${prNumber}/head:pr-${prNumber}`, { cwd: tmpDir, stdio: 'pipe' })
    execSync(`git checkout pr-${prNumber}`, { cwd: tmpDir, stdio: 'pipe' })
    try {
      execSync(`git fetch origin ${pr.base.ref}:${pr.base.ref}`, { cwd: tmpDir, stdio: 'pipe' })
    } catch {
      fileLog({ level: 'warn', event: 'base_branch_fetch_skipped', repo: `${owner}/${repoName}`, pr: prNumber, base: pr.base.ref })
    }

    await runWorkflow({
      owner, repoName, prNumber, pr,
      tmpDir, token, config, origin,
      reviewStart,
      log,
      crosscheckShas,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : (err as { message?: string }).message ?? 'unknown error'
    log(`  ✗ review failed: ${message}`)
    logError({ repo: `${owner}/${repoName}`, pr: prNumber, phase: 'review' }, err)
  } finally {
    rmSync(tmpDir, { force: true, recursive: true })
    inFlight.delete(key)
  }
}

export function runServe(configPath?: string) {
  const config = loadConfig(configPath)
  initLogger(config.logs)

  process.on('uncaughtException', (err) => {
    logUncaught('uncaughtException', err)
    console.error(chalk.red(`\n✗ Uncaught exception: ${err.message}`))
    process.exit(2)
  })
  process.on('unhandledRejection', (reason) => {
    logUncaught('unhandledRejection', reason)
    console.error(chalk.red(`\n✗ Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`))
    process.exit(2)
  })

  let token: string
  try {
    token = getGithubToken()
  } catch (err) {
    logError({ command: 'serve', phase: 'auth' }, err)
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }

  fileLog({ level: 'info', event: 'session_start', command: 'serve' })
  const webhookSecret = getWebhookSecret()

  const log = (msg: string) => {
    console.log(`[${new Date().toISOString()}] ${msg}`)
    fileLog({ level: 'info', event: 'message', message: msg })
  }

  const server = createWebhookServer(
    config,
    webhookSecret,
    (event) => { void handlePR(event, config, token, log) },
    log,
    fileLog,
  )

  server.listen(config.server.port, () => {
    const webhookUrl = `http://${hostname()}:${config.server.port}${config.server.webhook_path}`
    console.log(chalk.dim(`\n  "${randomFortune()}"\n`))
    console.log(chalk.bold('crosscheck serving\n'))
    console.log(chalk.yellow('  ⚠  serve is in beta — report issues at github.com/Motivation-Labs/crosscheck/issues\n'))
    console.log(`  mode      ${chalk.cyan(config.mode)}`)
    console.log(`  quality   ${chalk.cyan(config.quality.tier)}`)
    console.log(`  port      ${chalk.cyan(String(config.server.port))}`)
    console.log(`  endpoint  ${chalk.cyan(webhookUrl)}`)
    if (config.routing.allowed_authors.length === 0) {
      console.log()
      console.log(`  ${chalk.yellow('⚠')}  ${chalk.yellow('No author filter set — all PRs in monitored orgs/repos will be reviewed.')}`)
      console.log(`     ${chalk.dim('Add to config:')} ${chalk.cyan('routing:\n       allowed_authors:\n         - your-github-login')}`)
      console.log(`     ${chalk.dim('Or run')} ${chalk.cyan('crosscheck init')} ${chalk.dim('to auto-detect and apply.')}`)
    }
    console.log()
    if (config.orgs.length > 0) {
      console.log(chalk.dim('Register the endpoint above as a GitHub org webhook (content-type: application/json).'))
      for (const org of config.orgs) {
        console.log(chalk.dim(`  → https://github.com/organizations/${org}/settings/hooks`))
      }
    } else {
      console.log(chalk.dim('Register this URL as a GitHub webhook (content-type: application/json).'))
    }
    console.log(chalk.dim('Listening for pull_request events...\n'))
  })

  process.on('SIGINT', () => {
    console.log('\nShutting down...')
    fileLog({ level: 'info', event: 'session_end', command: 'serve' })
    server.close(() => process.exit(0))
  })
}
