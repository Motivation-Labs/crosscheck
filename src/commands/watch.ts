import { execSync } from 'child_process'
import chalk from 'chalk'
import SmeeClient from 'smee-client'
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

async function createSmeeChannel(): Promise<string> {
  const res = await fetch('https://smee.io/new', { method: 'HEAD', redirect: 'manual' })
  const location = res.headers.get('location')
  if (!location) throw new Error('Could not create smee.io channel')
  return location
}

async function registerGithubWebhook(
  owner: string,
  repo: string,
  webhookUrl: string,
  secret: string,
  token: string,
): Promise<number> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/hooks`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'web',
      active: true,
      events: ['pull_request'],
      config: { url: webhookUrl, content_type: 'json', secret },
    }),
  })
  if (!res.ok) {
    const err = await res.json() as { message?: string }
    throw new Error(`Failed to register webhook: ${err.message ?? res.status}`)
  }
  const data = await res.json() as { id: number }
  return data.id
}

async function deleteGithubWebhook(owner: string, repo: string, hookId: number, token: string) {
  await fetch(`https://api.github.com/repos/${owner}/${repo}/hooks/${hookId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  })
}

export async function runWatch(configPath?: string) {
  const config = loadConfig(configPath)
  const token = getGithubToken()
  const webhookSecret = getWebhookSecret()

  const log = (msg: string) => console.log(`${chalk.dim(new Date().toLocaleTimeString())} ${msg}`)

  const currentRepo = detectCurrentRepo()
  if (!currentRepo) {
    console.error(chalk.red('Could not detect a GitHub repo from git remote. Run inside a git repo or set repos in config.'))
    process.exit(1)
  }

  // PR deduplication — skip if already reviewing this PR+SHA
  const inFlight = new Set<string>()

  // Start local webhook server
  const server = createWebhookServer(
    config,
    webhookSecret,
    async (event: PREvent) => {
      const { pull_request: pr, repository: repo } = event
      const owner = repo.owner.login
      const repoName = repo.name
      const prNumber = event.number
      const key = `${owner}/${repoName}#${prNumber}@${pr.head.sha}`

      if (inFlight.has(key)) {
        log(chalk.dim(`PR #${prNumber} already in review — skipping duplicate event`))
        return
      }
      inFlight.add(key)

      log(`${chalk.bold(`PR #${prNumber}`)} ${event.action}: ${pr.title}`)
      const origin = detectPROrigin(pr.body ?? '', config)
      const reviewer = assignReviewer(origin, config)

      if (!reviewer) {
        log(chalk.dim(`  origin=${origin}, no reviewer — skipping`))
        inFlight.delete(key)
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
          reviewText = await runCodexReview(tmpDir, pr.base.ref, pr.title, config.quality, config.vendors.codex.model, config.vendors.codex.auth, log)
        } else {
          reviewText = await runClaudeReview(tmpDir, pr.base.ref, pr.title, config.quality, config.vendors.claude, config.budget.per_review_usd, log)
        }

        const octokit = createGithubClient(token)
        await postReviewComment(octokit, owner, repoName, prNumber, reviewText, reviewer)
        log(chalk.green(`  ✓ review posted to PR #${prNumber}`))
      } catch (err: unknown) {
        const error = err as { message?: string }
        log(chalk.red(`  ✗ ${error.message ?? 'unknown error'}`))
      } finally {
        rmSync(tmpDir, { force: true, recursive: true })
        inFlight.delete(key)
      }
    },
    log,
  )

  await new Promise<void>(resolve => server.listen(config.server.port, resolve))

  // Create smee.io channel and start proxy
  log('Creating smee.io tunnel...')
  const smeeUrl = await createSmeeChannel()
  const target = `http://localhost:${config.server.port}${config.server.webhook_path}`

  const smee = new SmeeClient({ source: smeeUrl, target, logger: { info: () => {}, error: console.error } })
  const smeeEvents = smee.start()

  // Register webhook on GitHub
  log(`Registering webhook on ${currentRepo.owner}/${currentRepo.repo}...`)
  let hookId: number | null = null
  try {
    hookId = await registerGithubWebhook(currentRepo.owner, currentRepo.repo, smeeUrl, webhookSecret, token)
    log(chalk.green(`Webhook registered (id ${hookId})`))
  } catch (err: unknown) {
    const error = err as { message?: string }
    log(chalk.yellow(`Could not auto-register webhook: ${error.message ?? 'unknown'}`))
    log(chalk.dim(`Register manually: ${smeeUrl} → ${target}`))
  }

  console.log(chalk.bold('\ncrosscheck watch\n'))
  console.log(`  repo      ${chalk.cyan(`${currentRepo.owner}/${currentRepo.repo}`)}`)
  console.log(`  mode      ${chalk.cyan(config.mode)}`)
  console.log(`  quality   ${chalk.cyan(config.quality.tier)}`)
  console.log(`  tunnel    ${chalk.cyan(smeeUrl)}`)
  console.log()
  console.log(chalk.dim('Waiting for PR events — Ctrl+C to stop and clean up.\n'))

  const cleanup = async () => {
    console.log('\nCleaning up...')
    smeeEvents.close()
    if (hookId !== null) {
      await deleteGithubWebhook(currentRepo.owner, currentRepo.repo, hookId, token)
      console.log('  webhook deregistered')
    }
    server.close(() => process.exit(0))
  }

  process.on('SIGINT', () => { void cleanup() })
  process.on('SIGTERM', () => { void cleanup() })
}
