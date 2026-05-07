import { execSync } from 'child_process'
import chalk from 'chalk'
import { createWebhookServer, type PREvent } from '../github/webhook.js'
import { createGithubClient, postReviewComment } from '../github/client.js'
import { detectPROrigin, assignReviewer } from '../github/detector.js'
import { runCodexReview } from '../reviewers/codex.js'
import { runClaudeReview } from '../reviewers/claude.js'
import { loadConfig, getGithubToken, getWebhookSecret } from '../config/loader.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

function detectCurrentRepo(): { owner: string; repo: string } | null {
  try {
    const remote = execSync('git remote get-url origin 2>/dev/null', { encoding: 'utf8' }).trim()
    const m = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/)
    if (m) return { owner: m[1], repo: m[2] }
  } catch { /* ignore */ }
  return null
}

export async function runWatch(configPath?: string) {
  const config = loadConfig(configPath)
  const token = getGithubToken()
  const webhookSecret = getWebhookSecret()

  const log = (msg: string) => console.log(`${chalk.dim(new Date().toLocaleTimeString())} ${msg}`)

  // Auto-detect repo from git remote
  const currentRepo = detectCurrentRepo()
  if (currentRepo) {
    log(`Detected repo: ${chalk.cyan(`${currentRepo.owner}/${currentRepo.repo}`)}`)
  }

  // Start local webhook server
  const server = createWebhookServer(
    config,
    webhookSecret,
    async (event: PREvent) => {
      const { pull_request: pr, repository: repo } = event
      const owner = repo.owner.login
      const repoName = repo.name
      const prNumber = event.number

      log(`${chalk.bold(`PR #${prNumber}`)} ${event.action}: ${pr.title}`)
      const origin = detectPROrigin(pr.body ?? '', config)
      const reviewer = assignReviewer(origin, config)

      if (!reviewer) {
        log(chalk.dim(`  origin=${origin}, no reviewer — skipping`))
        return
      }

      log(`  ${chalk.dim('→')} origin=${chalk.yellow(origin)}, reviewer=${chalk.cyan(reviewer)}`)

      const tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-repo-'))
      try {
        log('  cloning PR...')
        execSync(`gh repo clone ${owner}/${repoName} ${tmpDir} -- --depth=50 --quiet`, { stdio: 'pipe' })
        execSync(`git fetch origin pull/${prNumber}/head:pr-${prNumber}`, { cwd: tmpDir, stdio: 'pipe' })
        execSync(`git checkout pr-${prNumber}`, { cwd: tmpDir, stdio: 'pipe' })

        let reviewText: string
        if (reviewer === 'codex') {
          reviewText = await runCodexReview(tmpDir, pr.base.ref, pr.title, config.quality, config.vendors.codex.model, log)
        } else {
          reviewText = await runClaudeReview(tmpDir, pr.base.ref, pr.title, config.quality, config.vendors.claude, config.budget.per_review_usd, log)
        }

        const octokit = createGithubClient(token)
        await postReviewComment(octokit, owner, repoName, prNumber, reviewText, reviewer)
        log(chalk.green(`  ✓ review posted`))
      } catch (err: unknown) {
        const error = err as { message?: string }
        log(chalk.red(`  ✗ ${error.message ?? 'unknown error'}`))
      } finally {
        rmSync(tmpDir, { force: true, recursive: true })
      }
    },
    log,
  )

  server.listen(config.server.port, () => {
    console.log(chalk.bold('\ncrosscheck watch\n'))
    console.log(`  mode      ${chalk.cyan(config.mode)}`)
    console.log(`  quality   ${chalk.cyan(config.quality.tier)}`)
    console.log(`  port      ${chalk.cyan(String(config.server.port))}\n`)

    console.log(chalk.dim('To receive GitHub webhooks locally, use smee.io:'))
    console.log(chalk.dim(`  npx smee -u https://smee.io/<channel> -t http://localhost:${config.server.port}${config.server.webhook_path}\n`))
    console.log(chalk.dim('Waiting for PR events...\n'))
  })

  process.on('SIGINT', () => {
    console.log('\nStopping watch...')
    server.close(() => process.exit(0))
  })
}
