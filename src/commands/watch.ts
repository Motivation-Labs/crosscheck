import { execSync, spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
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

function spawnGhForward(target: string, secret: string, scope: { org: string } | { owner: string; repo: string }): ChildProcess {
  const scopeArg = 'org' in scope
    ? `--org=${scope.org}`
    : `--repo=${scope.owner}/${scope.repo}`

  return spawn(
    'gh',
    ['webhook', 'forward', '--events=pull_request', `--url=${target}`, `--secret=${secret}`, scopeArg],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
}

export async function runWatch(configPath?: string) {
  const config = loadConfig(configPath)
  const token = getGithubToken()
  const webhookSecret = getWebhookSecret()
  const target = `http://localhost:${config.server.port}${config.server.webhook_path}`

  const log = (msg: string) => console.log(`${chalk.dim(new Date().toLocaleTimeString())} ${msg}`)

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

  // Determine scopes to forward
  type Scope = { org: string } | { owner: string; repo: string }
  const scopes: Scope[] = []

  if (config.orgs.length > 0) {
    for (const org of config.orgs) scopes.push({ org })
  } else if (config.repos.length > 0) {
    for (const { owner, name } of config.repos) scopes.push({ owner, repo: name })
  } else {
    const detected = detectCurrentRepo()
    if (!detected) {
      console.error(chalk.red('Could not detect a GitHub repo from git remote. Run inside a git repo or set repos/orgs in config.'))
      server.close(() => process.exit(1))
      return
    }
    scopes.push({ owner: detected.owner, repo: detected.repo })
  }

  // Spawn gh webhook forward for each scope
  const forwarders: ChildProcess[] = []
  for (const scope of scopes) {
    const label = 'org' in scope ? scope.org : `${scope.owner}/${scope.repo}`
    log(`Starting webhook forwarder for ${label}...`)
    const proc = spawnGhForward(target, webhookSecret, scope)
    forwarders.push(proc)
    proc.stderr?.on('data', (d: Buffer) => {
      const line = d.toString().trim()
      if (line) log(chalk.dim(`  [gh forward ${label}] ${line}`))
    })
    proc.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        log(chalk.yellow(`  webhook forwarder for ${label} exited (code ${code})`))
      }
    })
    log(chalk.green(`  ✓ forwarding webhooks for ${label}`))
  }

  console.log(chalk.bold('\ncrosscheck watch\n'))
  if (config.orgs.length > 0) {
    console.log(`  orgs      ${chalk.cyan(config.orgs.join(', '))}`)
  } else if (config.repos.length > 0) {
    console.log(`  repos     ${chalk.cyan(config.repos.map(r => `${r.owner}/${r.name}`).join(', '))}`)
  }
  console.log(`  mode      ${chalk.cyan(config.mode)}`)
  console.log(`  quality   ${chalk.cyan(config.quality.tier)}`)
  console.log(`  port      ${chalk.cyan(String(config.server.port))}`)
  console.log()
  console.log(chalk.dim('Waiting for PR events — Ctrl+C to stop and clean up.\n'))

  const cleanup = () => {
    console.log('\nCleaning up...')
    for (const proc of forwarders) proc.kill()
    server.close(() => process.exit(0))
  }

  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
}
