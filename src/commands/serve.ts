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

async function handlePR(event: PREvent, config: ReturnType<typeof loadConfig>, token: string, log: (msg: string) => void) {
  const { pull_request: pr, repository: repo } = event
  const owner = repo.owner.login
  const repoName = repo.name
  const prNumber = event.number

  log(`PR #${prNumber} ${event.action}: ${pr.title}`)

  const origin = detectPROrigin(pr.body ?? '', config)
  const reviewer = assignReviewer(origin, config)

  if (!reviewer) {
    log(`  → origin=${origin}, no reviewer — skipping`)
    return
  }

  log(`  → origin=${origin}, reviewer=${reviewer}`)

  const tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-repo-'))
  try {
    log('  → cloning...')
    execSync(`gh repo clone ${owner}/${repoName} ${tmpDir} -- --depth=50 --quiet`, { stdio: 'pipe' })
    execSync(`git fetch origin pull/${prNumber}/head:pr-${prNumber}`, { cwd: tmpDir, stdio: 'pipe' })
    execSync(`git checkout pr-${prNumber}`, { cwd: tmpDir, stdio: 'pipe' })
    log('  → running review...')

    let reviewText: string
    if (reviewer === 'codex') {
      reviewText = await runCodexReview(tmpDir, pr.base.ref, pr.title, config.quality, config.vendors.codex.model, config.vendors.codex.auth, log)
    } else {
      reviewText = await runClaudeReview(tmpDir, pr.base.ref, pr.title, config.quality, config.vendors.claude, config.budget.per_review_usd, log)
    }

    const octokit = createGithubClient(token)
    await postReviewComment(octokit, owner, repoName, prNumber, reviewText, reviewer)
    log(`  ✓ review posted to PR #${prNumber}`)
  } catch (err: unknown) {
    const error = err as { message?: string }
    log(`  ✗ review failed: ${error.message ?? 'unknown error'}`)
  } finally {
    rmSync(tmpDir, { force: true, recursive: true })
  }
}

export function runServe(configPath?: string) {
  const config = loadConfig(configPath)
  const token = getGithubToken()
  const webhookSecret = getWebhookSecret()

  const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`)

  const server = createWebhookServer(
    config,
    webhookSecret,
    (event) => { void handlePR(event, config, token, log) },
    log,
  )

  server.listen(config.server.port, () => {
    console.log(chalk.bold('\ncrosscheck serving\n'))
    console.log(`  mode      ${chalk.cyan(config.mode)}`)
    console.log(`  quality   ${chalk.cyan(config.quality.tier)}`)
    console.log(`  port      ${chalk.cyan(String(config.server.port))}`)
    console.log(`  endpoint  ${chalk.cyan(`http://${hostname()}:${config.server.port}${config.server.webhook_path}`)}`)
    console.log()
    console.log(chalk.dim('Register this URL as a GitHub webhook (content-type: application/json).'))
    console.log(chalk.dim('Listening for pull_request events...\n'))
  })

  process.on('SIGINT', () => {
    console.log('\nShutting down...')
    server.close(() => process.exit(0))
  })
}
