import { execSync } from 'child_process'
import chalk from 'chalk'
import SmeeClient from 'smee-client'
import { createWebhookServer, type PREvent } from '../github/webhook.js'
import {
  createGithubClient,
  postReviewComment,
  registerRepoWebhook,
  deleteRepoWebhook,
  registerOrgWebhook,
  deleteOrgWebhook,
} from '../github/client.js'
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
  try {
    const res = await fetch('https://smee.io/new', { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(10000) })
    const location = res.headers.get('location')
    if (!location) throw new Error('no redirect location')
    return location
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Could not reach smee.io (${msg}).\n\n` +
      `  Option 1: open https://smee.io in your browser, click "Start a new channel", copy the URL,\n` +
      `            then run: crosscheck watch --tunnel-url https://smee.io/your-channel\n\n` +
      `  Option 2: check if your network/VPN blocks smee.io`
    )
  }
}

export async function runWatch(configPath?: string, tunnelUrl?: string) {
  const config = loadConfig(configPath)
  const token = getGithubToken()
  const webhookSecret = getWebhookSecret()

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

  // Create smee.io channel and start proxy
  let smeeUrl: string
  if (tunnelUrl) {
    smeeUrl = tunnelUrl
    log(`Using tunnel: ${chalk.cyan(smeeUrl)}`)
  } else {
    log('Creating smee.io tunnel...')
    smeeUrl = await createSmeeChannel()
  }
  const target = `http://localhost:${config.server.port}${config.server.webhook_path}`

  const smee = new SmeeClient({ source: smeeUrl, target, logger: { info: () => {}, error: console.error } })
  const smeeEvents = smee.start()

  // Track registered hooks for cleanup: [{type, key, hookId}]
  type RegisteredHook =
    | { type: 'org'; org: string; hookId: number }
    | { type: 'repo'; owner: string; repo: string; hookId: number }

  const registeredHooks: RegisteredHook[] = []

  if (config.orgs.length > 0) {
    // Org-level webhooks take priority
    for (const org of config.orgs) {
      log(`Registering org webhook for ${org}...`)
      try {
        const hookId = await registerOrgWebhook(org, smeeUrl, webhookSecret, token)
        registeredHooks.push({ type: 'org', org, hookId })
        log(chalk.green(`  ✓ org webhook registered for ${org} (id ${hookId})`))
      } catch (err: unknown) {
        const error = err as { message?: string }
        log(chalk.yellow(`  Could not register org webhook for ${org}: ${error.message ?? 'unknown'}`))
        log(chalk.dim(`  Register manually at: https://github.com/organizations/${org}/settings/hooks`))
      }
    }
  } else if (config.repos.length > 0) {
    // Explicit repo list
    for (const { owner, name } of config.repos) {
      log(`Registering repo webhook for ${owner}/${name}...`)
      try {
        const hookId = await registerRepoWebhook(owner, name, smeeUrl, webhookSecret, token)
        registeredHooks.push({ type: 'repo', owner, repo: name, hookId })
        log(chalk.green(`  ✓ repo webhook registered for ${owner}/${name} (id ${hookId})`))
      } catch (err: unknown) {
        const error = err as { message?: string }
        log(chalk.yellow(`  Could not register webhook for ${owner}/${name}: ${error.message ?? 'unknown'}`))
      }
    }
  } else {
    // Auto-detect from git remote
    const currentRepo = detectCurrentRepo()
    if (!currentRepo) {
      console.error(chalk.red('Could not detect a GitHub repo from git remote. Run inside a git repo or set repos/orgs in config.'))
      smeeEvents.close()
      server.close(() => process.exit(1))
      return
    }
    log(`Registering webhook on ${currentRepo.owner}/${currentRepo.repo}...`)
    try {
      const hookId = await registerRepoWebhook(currentRepo.owner, currentRepo.repo, smeeUrl, webhookSecret, token)
      registeredHooks.push({ type: 'repo', owner: currentRepo.owner, repo: currentRepo.repo, hookId })
      log(chalk.green(`Webhook registered (id ${hookId})`))
    } catch (err: unknown) {
      const error = err as { message?: string }
      log(chalk.yellow(`Could not auto-register webhook: ${error.message ?? 'unknown'}`))
      log(chalk.dim(`Register manually: ${smeeUrl} → ${target}`))
    }
  }

  console.log(chalk.bold('\ncrosscheck watch\n'))
  if (config.orgs.length > 0) {
    console.log(`  orgs      ${chalk.cyan(config.orgs.join(', '))}`)
  } else if (config.repos.length > 0) {
    console.log(`  repos     ${chalk.cyan(config.repos.map(r => `${r.owner}/${r.name}`).join(', '))}`)
  }
  console.log(`  mode      ${chalk.cyan(config.mode)}`)
  console.log(`  quality   ${chalk.cyan(config.quality.tier)}`)
  console.log(`  tunnel    ${chalk.cyan(smeeUrl)}`)
  console.log()
  console.log(chalk.dim('Waiting for PR events — Ctrl+C to stop and clean up.\n'))

  const cleanup = async () => {
    console.log('\nCleaning up...')
    smeeEvents.close()
    for (const hook of registeredHooks) {
      try {
        if (hook.type === 'org') {
          await deleteOrgWebhook(hook.org, hook.hookId, token)
          console.log(`  org webhook deregistered for ${hook.org}`)
        } else {
          await deleteRepoWebhook(hook.owner, hook.repo, hook.hookId, token)
          console.log(`  repo webhook deregistered for ${hook.owner}/${hook.repo}`)
        }
      } catch { /* best-effort cleanup */ }
    }
    server.close(() => process.exit(0))
  }

  process.on('SIGINT', () => { void cleanup() })
  process.on('SIGTERM', () => { void cleanup() })
}
