import { execSync, spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import chalk from 'chalk'
import ora from 'ora'
import { createWebhookServer, type PREvent } from '../github/webhook.js'
import {
  registerOrgWebhook,
  deleteOrgWebhook,
  registerRepoWebhook,
  deleteRepoWebhook,
} from '../github/client.js'
import { detectPROrigin, assignReviewer } from '../github/detector.js'
import { loadConfig, getGithubToken, getWebhookSecret } from '../config/loader.js'
import { randomFortune } from '../lib/fortune.js'
import { initLogger, log as fileLog, logError, logUncaught } from '../lib/logger.js'
import { runWorkflow } from '../lib/runner.js'
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
    logError({ command: 'watch', phase: 'auth' }, err)
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }

  fileLog({ level: 'info', event: 'session_start', command: 'watch' })
  const webhookSecret = getWebhookSecret()
  const webhookPath = config.server.webhook_path

  const log = (msg: string) => {
    console.log(`${chalk.dim(new Date().toLocaleTimeString())} ${msg}`)
    fileLog({ level: 'info', event: 'message', message: msg })
  }

  // PR deduplication — skip if already reviewing this PR+SHA
  const inFlight = new Set<string>()
  // SHAs pushed by the address step — skip synchronize events from our own commits
  const crosscheckShas = new Set<string>()

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

      // Skip synchronize events triggered by our own address commits
      if (crosscheckShas.has(pr.head.sha)) {
        fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'crosscheck_sha', sha: pr.head.sha })
        return
      }

      inFlight.add(key)

      const author = pr.user.login

      // Author filter — skip if allowed_authors is set and this author is not in it
      const allowedAuthors = config.routing.allowed_authors
      if (allowedAuthors.length > 0 && !allowedAuthors.includes(author)) {
        fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'author_not_allowed', author })
        inFlight.delete(key)
        return
      }

      log(`${chalk.bold(`PR #${prNumber}`)} ${event.action}: ${chalk.dim(pr.title)}`)
      const origin = detectPROrigin(pr.body ?? '', config)
      const reviewer = assignReviewer(origin, config)

      fileLog({ level: 'info', event: 'pr_received', repo: `${owner}/${repoName}`, pr: prNumber, sha: pr.head.sha, action: event.action, origin, author })

      if (!reviewer) {
        log(chalk.dim(`  origin=${origin} — skipping (no reviewer assigned)`))
        inFlight.delete(key)
        return
      }

      log(`  origin=${chalk.yellow(origin)}  reviewer=${chalk.cyan(reviewer)}`)

      const tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-repo-'))
      const spinner = ora({ indent: 2 })
      const reviewStart = Date.now()
      try {
        spinner.start('cloning...')
        execSync(`gh repo clone ${owner}/${repoName} ${tmpDir} -- --depth=50 --quiet`, { stdio: 'pipe', env: { ...process.env, GITHUB_TOKEN: token, GH_TOKEN: token } })
        execSync(`git fetch origin pull/${prNumber}/head:pr-${prNumber}`, { cwd: tmpDir, stdio: 'pipe' })
        execSync(`git checkout pr-${prNumber}`, { cwd: tmpDir, stdio: 'pipe' })
        // Fetch the base branch after checking out the PR branch so we are never
        // on the base branch during the fetch (git refuses to update a checked-out ref).
        try {
          execSync(`git fetch origin ${pr.base.ref}:${pr.base.ref}`, { cwd: tmpDir, stdio: 'pipe' })
        } catch {
          fileLog({ level: 'warn', event: 'base_branch_fetch_skipped', repo: `${owner}/${repoName}`, pr: prNumber, base: pr.base.ref })
        }
        spinner.succeed('cloned')

        await runWorkflow({
          owner, repoName, prNumber, pr,
          tmpDir, token, config, origin,
          reviewStart,
          log,
          crosscheckShas,
        })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        logError({ repo: `${owner}/${repoName}`, pr: prNumber, phase: 'review' }, err)
        log(`  ✗ ${message}`)
      } finally {
        rmSync(tmpDir, { force: true, recursive: true })
        inFlight.delete(key)
      }
    },
    log,
    fileLog,
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

  // Determine scopes once — these don't change between tunnel reconnects
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
      server.close(() => process.exit(1))
      return
    }
    scopes.push({ owner: detected.owner, repo: detected.repo })
  }

  type RegisteredHook =
    | { type: 'org'; org: string; hookId: number }
    | { type: 'repo'; owner: string; repo: string; hookId: number }

  // Mutable tunnel session state — replaced on each reconnect
  let currentTunnelProc: ChildProcess | null = null
  let currentRegistered: RegisteredHook[] = []
  let running = true

  async function deleteCurrentWebhooks(): Promise<void> {
    for (const hook of currentRegistered) {
      try {
        if (hook.type === 'org') {
          await deleteOrgWebhook(hook.org, hook.hookId, token)
        } else {
          await deleteRepoWebhook(hook.owner, hook.repo, hook.hookId, token)
        }
      } catch { /* best-effort */ }
    }
    currentRegistered = []
  }

  const cleanup = async () => {
    running = false
    console.log('\nCleaning up...')
    currentTunnelProc?.kill()
    await deleteCurrentWebhooks()
    fileLog({ level: 'info', event: 'session_end', command: 'watch' })
    server.close(() => process.exit(0))
  }

  process.on('SIGINT', () => { void cleanup() })
  process.on('SIGTERM', () => { void cleanup() })

  // Print banner once at startup
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
  if (config.routing.allowed_authors.length === 0) {
    console.log()
    console.log(`  ${chalk.yellow('⚠')}  ${chalk.yellow('No author filter set — all PRs in monitored orgs/repos will be reviewed.')}`)
    console.log(`     ${chalk.dim('Add to config:')} ${chalk.cyan('routing:\n       allowed_authors:\n         - your-github-login')}`)
    console.log(`     ${chalk.dim('Or run')} ${chalk.cyan('crosscheck init')} ${chalk.dim('to auto-detect and apply.')}`)
  }
  console.log()

  // Tunnel reconnect loop — runs until SIGINT/SIGTERM
  let reconnectDelay = 5_000
  while (running) {
    log('Opening tunnel via localhost.run...')
    let tunnelUrl: string
    let tunnelProc: ChildProcess
    try {
      ;({ url: tunnelUrl, proc: tunnelProc } = await openTunnel(config.server.port))
    } catch (err: unknown) {
      if (!running) break
      const msg = err instanceof Error ? err.message : String(err)
      log(chalk.yellow(`  ✗ tunnel failed: ${msg} — retrying in ${reconnectDelay / 1000}s`))
      fileLog({ level: 'warn', event: 'tunnel_error', message: msg })
      await new Promise(r => setTimeout(r, reconnectDelay))
      reconnectDelay = Math.min(reconnectDelay * 2, 60_000)
      continue
    }
    reconnectDelay = 5_000  // reset backoff on success

    currentTunnelProc = tunnelProc
    const webhookUrl = `${tunnelUrl}${webhookPath}`
    log(chalk.green(`  ✓ tunnel ready: ${chalk.cyan(tunnelUrl)}`))
    console.log(`  tunnel    ${chalk.cyan(tunnelUrl)}`)
    console.log(chalk.dim('Waiting for PR events — Ctrl+C to stop.\n'))
    fileLog({ level: 'info', event: 'tunnel_opened', url: tunnelUrl })

    // Register webhooks for this tunnel session
    currentRegistered = []
    for (const scope of scopes) {
      const label = 'org' in scope ? scope.org : `${scope.owner}/${scope.repo}`
      try {
        if ('org' in scope) {
          const hookId = await registerOrgWebhook(scope.org, webhookUrl, webhookSecret, token)
          currentRegistered.push({ type: 'org', org: scope.org, hookId })
        } else {
          const hookId = await registerRepoWebhook(scope.owner, scope.repo, webhookUrl, webhookSecret, token)
          currentRegistered.push({ type: 'repo', owner: scope.owner, repo: scope.repo, hookId })
        }
        log(chalk.green(`  ✓ webhook registered for ${label}`))
        fileLog({ level: 'info', event: 'webhook_registered', scope: label, url: webhookUrl })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        const isCreds = /bad credentials|\[401\]/i.test(msg)
        // 403 always means insufficient scope.
        // 404 on an org webhook means the token lacks admin:org_hook scope (GitHub
        // hides the endpoint rather than returning 403). For repo webhooks, 404
        // means the repo itself is not found — show the raw error instead.
        const isScope = /admin:org|write:org|forbidden|\[403\]|must have admin|resource not accessible/i.test(msg)
          || ('org' in scope && /\[404\]/i.test(msg))
        log(chalk.yellow(`  ⚠ could not register webhook for ${label}`))
        if (isCreds) {
          log(chalk.dim(`    token invalid or expired — run: gh auth refresh`))
          log(chalk.dim(`    or regenerate a PAT at github.com/settings/tokens`))
        } else if (isScope) {
          log(chalk.dim(`    token needs admin:org_hook scope and org Owner role`))
          log(chalk.dim(`    run: gh auth refresh -s admin:org_hook`))
          log(chalk.dim(`    or create a PAT at github.com/settings/tokens with admin:org scope`))
        } else {
          log(chalk.dim(`    ${msg}`))
        }
        log(chalk.dim(`    to register manually: Payload URL = ${webhookUrl}  Secret = (see ~/.crosscheck/webhook-secret)`))
        log(chalk.dim(`    https://github.com/organizations/${label}/settings/hooks`))
      }
    }

    // Wait for this tunnel session to end
    await new Promise<void>(resolve => {
      tunnelProc.on('exit', resolve)
      tunnelProc.on('error', resolve)
    })

    if (!running) break

    // Clean up webhooks tied to the old URL before reconnecting
    await deleteCurrentWebhooks()
    log(chalk.yellow('  tunnel disconnected — reconnecting in 5s...'))
    fileLog({ level: 'warn', event: 'tunnel_closed', reconnecting: true })
    await new Promise(r => setTimeout(r, reconnectDelay))
  }
}
