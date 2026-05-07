import { mkdtempSync, rmSync } from 'fs'
import { tmpdir, hostname } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'
import chalk from 'chalk'
import { createWebhookServer, type PREvent } from '../github/webhook.js'
import { createGithubClient, postReviewComment } from '../github/client.js'
import { detectPROrigin, assignReviewer } from '../github/detector.js'
import { runCodexReview } from '../reviewers/codex.js'
import { runClaudeReview } from '../reviewers/claude.js'
import { loadConfig, getGithubToken, getWebhookSecret } from '../config/loader.js'
import { parseVerdict, formatVerdict, prependVerdictToComment } from '../lib/verdict.js'
import { randomFortune } from '../lib/fortune.js'
import { initLogger, log as fileLog, logError, logUncaught } from '../lib/logger.js'

// Deduplication — keyed by owner/repo#pr@sha
const inFlight = new Set<string>()

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
  inFlight.add(key)

  log(`PR #${prNumber} ${event.action}: ${pr.title}`)

  const origin = detectPROrigin(pr.body ?? '', config)
  const reviewer = assignReviewer(origin, config)

  fileLog({ level: 'info', event: 'pr_received', repo: `${owner}/${repoName}`, pr: prNumber, sha: pr.head.sha, action: event.action, origin })

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
    execSync(`gh repo clone ${owner}/${repoName} ${tmpDir} -- --depth=50 --quiet`, { stdio: 'pipe' })
    execSync(`git fetch origin pull/${prNumber}/head:pr-${prNumber}`, { cwd: tmpDir, stdio: 'pipe' })
    execSync(`git checkout pr-${prNumber}`, { cwd: tmpDir, stdio: 'pipe' })
    log('  → running review...')

    fileLog({ level: 'info', event: 'review_started', repo: `${owner}/${repoName}`, pr: prNumber, reviewer })
    let rawReview: string
    if (reviewer === 'codex') {
      rawReview = await runCodexReview(tmpDir, pr.base.ref, pr.title, config.quality, config.vendors.codex.model, config.vendors.codex.auth, log)
    } else {
      rawReview = await runClaudeReview(tmpDir, pr.base.ref, pr.title, config.quality, config.vendors.claude, config.budget.per_review_usd, log)
    }

    const { verdict, clean } = parseVerdict(rawReview)
    const commentBody = prependVerdictToComment(clean, verdict)
    fileLog({ level: 'info', event: 'review_complete', repo: `${owner}/${repoName}`, pr: prNumber, reviewer, verdict, duration_ms: Date.now() - reviewStart })

    const octokit = createGithubClient(token)
    await postReviewComment(octokit, owner, repoName, prNumber, commentBody, reviewer)
    log(`  ✓ review posted to PR #${prNumber}  ${formatVerdict(verdict)}`)
    fileLog({ level: 'info', event: 'comment_posted', repo: `${owner}/${repoName}`, pr: prNumber, url: `https://github.com/${owner}/${repoName}/pull/${prNumber}` })
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
