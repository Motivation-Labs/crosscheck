import { execSync, spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import chalk from 'chalk'
import ora from 'ora'
import { createWebhookServer, type PREvent } from '../github/webhook.js'
import {
  createGithubClient,
  postReviewComment,
  registerOrgWebhook,
  deleteOrgWebhook,
  registerRepoWebhook,
  deleteRepoWebhook,
} from '../github/client.js'
import { detectPROrigin, assignReviewer } from '../github/detector.js'
import { runCodexReview } from '../reviewers/codex.js'
import { runClaudeReview } from '../reviewers/claude.js'
import { loadConfig, getGithubToken, getWebhookSecret } from '../config/loader.js'
import { parseVerdict, formatVerdict, prependVerdictToComment } from '../lib/verdict.js'
import { randomFortune } from '../lib/fortune.js'
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

// Opens a localhost.run SSH tunnel. Resolves with the public base URL once
// the tunnel is ready. Rejects after 20s if no URL appears in the output.
function openTunnel(localPort: number): Promise<{ url: string; proc: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ssh', [
      '-R', `80:localhost:${localPort}`,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=30',
      '-o', 'LogLevel=ERROR',
      'nokey@localhost.run',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })

    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error('Tunnel did not start within 20s — check your internet connection'))
    }, 20000)

    const onData = (data: Buffer) => {
      const text = data.toString()
      const match = text.match(/https:\/\/[a-zA-Z0-9.-]+\.(?:localhost\.run|lhr\.life)[^\s]*/i)
      if (match) {
        clearTimeout(timer)
        resolve({ url: match[0].replace(/\/$/, ''), proc })
      }
    }

    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)

    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0 && code !== null) {
        reject(new Error(`SSH tunnel exited (code ${code})`))
      }
    })
  })
}

export async function runWatch(configPath?: string) {
  const config = loadConfig(configPath)
  const token = getGithubToken()
  const webhookSecret = getWebhookSecret()
  const webhookPath = config.server.webhook_path

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
        log(chalk.dim(`PR #${prNumber} already in review — skipping duplicate`))
        return
      }
      inFlight.add(key)

      log(`${chalk.bold(`PR #${prNumber}`)} ${event.action}: ${chalk.dim(pr.title)}`)
      const origin = detectPROrigin(pr.body ?? '', config)
      const reviewer = assignReviewer(origin, config)

      if (!reviewer) {
        log(chalk.dim(`  origin=${origin} — skipping (no reviewer assigned)`))
        inFlight.delete(key)
        return
      }

      log(`  origin=${chalk.yellow(origin)}  reviewer=${chalk.cyan(reviewer)}`)

      const tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-repo-'))
      const spinner = ora({ indent: 2 })
      try {
        spinner.start('cloning...')
        execSync(`gh repo clone ${owner}/${repoName} ${tmpDir} -- --depth=50 --quiet`, { stdio: 'pipe' })
        execSync(`git fetch origin pull/${prNumber}/head:pr-${prNumber}`, { cwd: tmpDir, stdio: 'pipe' })
        execSync(`git checkout pr-${prNumber}`, { cwd: tmpDir, stdio: 'pipe' })
        spinner.succeed('cloned')

        spinner.start(`${reviewer} reviewing...`)
        let rawReview: string
        if (reviewer === 'codex') {
          rawReview = await runCodexReview(tmpDir, pr.base.ref, pr.title, config.quality, config.vendors.codex.model, config.vendors.codex.auth)
        } else {
          rawReview = await runClaudeReview(tmpDir, pr.base.ref, pr.title, config.quality, config.vendors.claude, config.budget.per_review_usd)
        }
        spinner.succeed('review complete')

        const { verdict, clean } = parseVerdict(rawReview)
        const commentBody = prependVerdictToComment(clean, verdict)

        spinner.start('posting comment...')
        const octokit = createGithubClient(token)
        await postReviewComment(octokit, owner, repoName, prNumber, commentBody, reviewer)
        spinner.succeed(`posted → github.com/${owner}/${repoName}/pull/${prNumber}`)

        log(formatVerdict(verdict))
      } catch (err: unknown) {
        spinner.fail(err instanceof Error ? err.message : String(err))
      } finally {
        rmSync(tmpDir, { force: true, recursive: true })
        inFlight.delete(key)
      }
    },
    log,
  )

  await new Promise<void>((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(
          `Port ${config.server.port} is already in use.\n` +
          `  Another crosscheck instance may be running. Stop it first, or change the port in config:\n` +
          `    server:\n      port: 7892`
        ))
      } else {
        reject(err)
      }
    })
    server.listen(config.server.port, resolve)
  }).catch((err: Error) => {
    console.error(chalk.red(`\n✗ ${err.message}`))
    process.exit(1)
  })

  // Open SSH tunnel via localhost.run
  log('Opening tunnel via localhost.run...')
  let tunnelUrl: string
  let tunnelProc: ChildProcess
  try {
    ;({ url: tunnelUrl, proc: tunnelProc } = await openTunnel(config.server.port))
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(chalk.red(`\n✗ Could not open tunnel: ${msg}`))
    server.close(() => process.exit(1))
    return
  }

  const webhookUrl = `${tunnelUrl}${webhookPath}`
  log(chalk.green(`  ✓ tunnel ready: ${chalk.cyan(tunnelUrl)}`))

  tunnelProc.on('exit', (code) => {
    if (code !== 0 && code !== null) log(chalk.yellow('  tunnel disconnected'))
  })

  // Determine scopes
  type Scope = { org: string } | { owner: string; repo: string }
  const scopes: Scope[] = []

  if (config.orgs.length > 0) {
    for (const org of config.orgs) scopes.push({ org })
  } else if (config.repos.length > 0) {
    for (const { owner, name } of config.repos) scopes.push({ owner, repo: name })
  } else {
    const detected = detectCurrentRepo()
    if (!detected) {
      console.error(chalk.red('No repos or orgs configured. Run inside a git repo or set repos/orgs in config.'))
      tunnelProc.kill()
      server.close(() => process.exit(1))
      return
    }
    scopes.push({ owner: detected.owner, repo: detected.repo })
  }

  // Register GitHub webhooks
  type RegisteredHook =
    | { type: 'org'; org: string; hookId: number }
    | { type: 'repo'; owner: string; repo: string; hookId: number }
  const registered: RegisteredHook[] = []

  for (const scope of scopes) {
    const label = 'org' in scope ? scope.org : `${scope.owner}/${scope.repo}`
    try {
      if ('org' in scope) {
        const hookId = await registerOrgWebhook(scope.org, webhookUrl, webhookSecret, token)
        registered.push({ type: 'org', org: scope.org, hookId })
      } else {
        const hookId = await registerRepoWebhook(scope.owner, scope.repo, webhookUrl, webhookSecret, token)
        registered.push({ type: 'repo', owner: scope.owner, repo: scope.repo, hookId })
      }
      log(chalk.green(`  ✓ webhook registered for ${label}`))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log(chalk.yellow(`  ⚠ could not register webhook for ${label}: ${msg}`))
      log(chalk.dim(`    register manually: ${webhookUrl}`))
    }
  }

  // Summary banner
  console.log(chalk.dim(`\n  "${randomFortune()}"\n`))
  console.log(chalk.bold('crosscheck watch\n'))
  if (config.orgs.length > 0) {
    console.log(`  orgs      ${chalk.cyan(config.orgs.join(', '))}`)
  } else {
    const labels = scopes.map(s => 'org' in s ? s.org : `${s.owner}/${s.repo}`)
    console.log(`  repos     ${chalk.cyan(labels.join(', '))}`)
  }
  console.log(`  mode      ${chalk.cyan(config.mode)}`)
  console.log(`  quality   ${chalk.cyan(config.quality.tier)}`)
  console.log(`  tunnel    ${chalk.cyan(tunnelUrl)}`)
  console.log()
  console.log(chalk.dim('Waiting for PR events — Ctrl+C to stop.\n'))

  // Cleanup on exit
  const cleanup = async () => {
    console.log('\nCleaning up...')
    tunnelProc.kill()
    for (const hook of registered) {
      try {
        if (hook.type === 'org') {
          await deleteOrgWebhook(hook.org, hook.hookId, token)
        } else {
          await deleteRepoWebhook(hook.owner, hook.repo, hook.hookId, token)
        }
      } catch { /* best-effort */ }
    }
    server.close(() => process.exit(0))
  }

  process.on('SIGINT', () => { void cleanup() })
  process.on('SIGTERM', () => { void cleanup() })
}
