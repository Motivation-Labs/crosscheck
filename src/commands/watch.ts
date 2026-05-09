import { execSync, spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import chalk from 'chalk'
import { createWebhookServer, type PREvent } from '../github/webhook.js'
import {
  registerOrgWebhook,
  deleteOrgWebhook,
  registerRepoWebhook,
  deleteRepoWebhook,
  listUserRepos,
} from '../github/client.js'
import { detectPROrigin, assignReviewer } from '../github/detector.js'
import { loadConfig, getGithubToken, getWebhookSecret, resolveConfigPath, detectGitHubLogin, patchAllowedAuthors } from '../config/loader.js'
import { randomFortune } from '../lib/fortune.js'
import { initLogger, log as fileLog, logError, logUncaught } from '../lib/logger.js'
import { isAuthorAllowed } from '../lib/filter.js'
import { runWorkflow } from '../lib/runner.js'
import { loadWorkflow } from '../lib/workflow.js'
import { PRBoard } from '../lib/board.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Compute PR diff size in lines, excluding noise (lockfiles, binaries, data files)
const NOISE_EXT = /\.(lock|snap|min\.js|min\.css|csv|json|png|jpg|jpeg|gif|svg|mp4|woff2?|ttf|eot|ico|pdf)$/i

function computePRLoc(tmpDir: string, baseBranch: string): number {
  try {
    const stat = execSync(`git diff --stat origin/${baseBranch}...HEAD`, { cwd: tmpDir, encoding: 'utf8' })
    let total = 0
    for (const line of stat.split('\n')) {
      const m = line.match(/^\s+(.+?)\s+\|\s+(\d+)/)
      if (!m) continue
      const file = m[1].trim().replace(/\{.*?=> /, '').replace('}', '')  // handle rename notation
      if (!NOISE_EXT.test(file)) total += parseInt(m[2], 10)
    }
    return total
  } catch {
    return 0
  }
}

function detectCurrentRepo(): { owner: string; repo: string } | null {
  try {
    const remote = execSync('git remote get-url origin 2>/dev/null', { encoding: 'utf8' }).trim()
    const m = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/)
    if (m) return { owner: m[1], repo: m[2] }
  } catch { /* ignore */ }
  return null
}

// lhr.life tunnels can go dead (503) without the SSH process exiting.
// Polls every 60s and kills the proc after 2 consecutive failures (~2 min detection).
function waitForTunnelEnd(tunnelProc: ChildProcess, tunnelUrl: string): Promise<void> {
  return new Promise<void>(resolve => {
    let failCount = 0

    const check = setInterval(async () => {
      let alive = false
      try {
        const res = await fetch(tunnelUrl, { signal: AbortSignal.timeout(8000) })
        alive = res.status !== 503
      } catch { /* network error = dead */ }

      if (!alive) {
        if (++failCount >= 2) {
          clearInterval(check)
          tunnelProc.kill()
        }
      } else {
        failCount = 0
      }
    }, 60_000)

    tunnelProc.on('exit', () => { clearInterval(check); resolve() })
    tunnelProc.on('error', () => { clearInterval(check); resolve() })
  })
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
  let config = loadConfig(configPath)
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

  // Board manages all terminal output after startup
  const board = new PRBoard()
  board.setConfig(config, loadWorkflow(process.cwd()))

  // Thin wrapper: routes important messages to both terminal and file log
  const bLog = (line1: string, line2?: string) => {
    board.log(line1, line2)
    fileLog({ level: 'info', event: 'message', message: line2 ? `${line1} ${line2}` : line1 })
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
        fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'duplicate' })
        return
      }

      // Skip synchronize events triggered by our own address commits
      if (crosscheckShas.has(pr.head.sha)) {
        fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'crosscheck_sha', sha: pr.head.sha })
        return
      }

      inFlight.add(key)

      const author = pr.user.login

      if (!isAuthorAllowed(config.routing.allowed_authors, author)) {
        fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'author_not_allowed', author })
        inFlight.delete(key)
        return
      }

      const origin = detectPROrigin(pr.body ?? '', config, pr.user.login)
      const reviewer = assignReviewer(origin, config)

      fileLog({ level: 'info', event: 'pr_received', repo: `${owner}/${repoName}`, pr: prNumber, sha: pr.head.sha, action: event.action, origin, author })

      if (!reviewer) {
        fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'no_reviewer', origin })
        inFlight.delete(key)
        return
      }

      const ts = chalk.dim(new Date().toLocaleTimeString())
      const tsIndent = ' '.repeat(new Date().toLocaleTimeString().length + 2)
      bLog(
        `${ts}  PR #${prNumber} ${event.action}  ${chalk.dim(pr.title)}`,
        `${tsIndent}origin=${chalk.yellow(origin)}  reviewer=${chalk.cyan(reviewer)}`
      )

      board.addPR(key, prNumber, `${owner}/${repoName}`, pr.head.ref)
      const reviewStart = Date.now()
      const tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-repo-'))

      try {
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

        // Measure PR size (excluding noise files) and push to the board slot
        const prLoc = computePRLoc(tmpDir, pr.base.ref)
        board.updatePR(key, { prLoc })

        const { verdict } = await runWorkflow({
          owner, repoName, prNumber, pr,
          tmpDir, token, config, origin,
          reviewStart,
          log: (msg: string) => bLog(`${chalk.dim(new Date().toLocaleTimeString())}  ${msg}`),
          onPhaseChange: (label, data) => board.updatePR(key, { label, ...data }),
          crosscheckShas,
        })

        void verdict  // verdict already flowed into the board slot via onPhaseChange
        board.completePR(key, {
          elapsedMs: Date.now() - reviewStart,
          url: `github.com/${owner}/${repoName}/pull/${prNumber}`,
        })

      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        board.failPR(key, message)
        logError({ repo: `${owner}/${repoName}`, pr: prNumber, phase: 'review' }, err)
      } finally {
        rmSync(tmpDir, { force: true, recursive: true })
        inFlight.delete(key)
      }
    },
    (msg: string) => bLog(chalk.dim(new Date().toLocaleTimeString()) + '  ' + msg),
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

  // Determine scopes once — these don't change between tunnel reconnects.
  // orgs, users, and repos are additive: all configured sources contribute scopes.
  type Scope = { org: string } | { owner: string; repo: string }
  const scopes: Scope[] = []

  for (const org of config.orgs) scopes.push({ org })

  const userRepoResults: Array<{ user: string; count: number } | { user: string; error: string }> = []
  if (config.users.length > 0) {
    for (const user of config.users) {
      try {
        const repos = await listUserRepos(user, token)
        for (const { owner, name } of repos) scopes.push({ owner, repo: name })
        userRepoResults.push({ user, count: repos.length })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        userRepoResults.push({ user, error: msg })
      }
    }
  }

  for (const { owner, name } of config.repos) scopes.push({ owner, repo: name })

  if (scopes.length === 0 && config.tunnel.backend !== 'smee') {
    // localhost.run needs a target repo to auto-register webhooks.
    // smee users register the webhook manually — no target required here.
    const detected = detectCurrentRepo()
    if (!detected) {
      console.error(chalk.red('No repos, users, or orgs configured. Run inside a git repo or set repos/users/orgs in config.'))
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
    board.stop()
    console.log('\nCleaning up...')
    currentTunnelProc?.kill()
    await deleteCurrentWebhooks()
    fileLog({ level: 'info', event: 'session_end', command: 'watch' })
    server.close(() => process.exit(0))
  }

  process.on('SIGINT', () => { void cleanup() })
  process.on('SIGTERM', () => { void cleanup() })

  // ── Static startup banner ─────────────────────────────────────────────────
  console.log(chalk.dim(`\n  "${randomFortune()}"\n`))
  console.log(chalk.bold('crosscheck watch\n'))
  if (config.orgs.length > 0) {
    console.log(`  orgs      ${chalk.cyan(config.orgs.join(', '))}`)
  }
  if (config.users.length > 0) {
    console.log(`  users     ${chalk.cyan(config.users.join(', '))}`)
    for (const r of userRepoResults) {
      if ('error' in r) {
        console.log(`            ${chalk.yellow(`⚠ ${r.user}: could not list repos — ${r.error}`)}`)
      } else {
        console.log(`            ${chalk.dim(`${r.user}: ${r.count} repo(s) registered`)}`)
      }
    }
  }
  if (config.orgs.length === 0 && config.users.length === 0) {
    const labels = scopes.map(s => 'org' in s ? s.org : `${s.owner}/${s.repo}`)
    console.log(`  repos     ${chalk.cyan(labels.join(', '))}`)
  }
  console.log(`  mode      ${chalk.cyan(config.mode)}`)
  console.log(`  quality   ${chalk.cyan(config.quality.tier)}`)
  const cfgPath = resolveConfigPath(configPath)
  console.log(`  config    ${chalk.dim(cfgPath ?? 'none (using defaults)')}  ${chalk.dim('← edit to change above')}`)
  if (config.routing.allowed_authors.length === 0) {
    const login = detectGitHubLogin()
    if (login && cfgPath && patchAllowedAuthors(cfgPath, login)) {
      config = loadConfig(configPath)
      console.log(`  ${chalk.green('✓')} allowed_authors set to ${chalk.cyan(login)} ${chalk.dim(`(auto-detected — edit ${cfgPath} to change)`)}`)
    } else {
      console.log()
      console.log(`  ${chalk.yellow('⚠')}  ${chalk.yellow('No author filter set — all PRs in monitored orgs/repos will be reviewed.')}`)
      console.log(`     ${chalk.dim('Add to config:')} ${chalk.cyan('routing:\n       allowed_authors:\n         - your-github-login')}`)
    }
  }
  console.log()

  // Board starts after the banner — all output below is live-updated
  board.start()

  // ── Smee mode ─────────────────────────────────────────────────────────────
  // No tunnel management or webhook auto-registration needed.
  // The user points their GitHub webhook to the smee channel URL once.
  if (config.tunnel.backend === 'smee') {
    const channelUrl = config.tunnel.smee_channel
    if (!channelUrl) {
      board.stop()
      console.error(chalk.red('✗ tunnel.smee_channel is required when tunnel.backend: smee'))
      console.error(chalk.dim('  Visit https://smee.io/new to get a free channel URL.'))
      server.close(() => process.exit(1))
      return
    }
    board.setTunnel('smee', channelUrl, true)
    fileLog({ level: 'info', event: 'tunnel_opened', url: channelUrl, backend: 'smee' })

    let smeeRetryDelay = 5_000
    while (running) {
      const smeeProc = spawn('smee', [
        '--url', channelUrl,
        '--path', config.server.webhook_path,
        '--port', String(config.server.port),
      ], { stdio: 'pipe' })
      currentTunnelProc = smeeProc

      try {
        await new Promise<void>((resolve, reject) => {
          smeeProc.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'ENOENT') {
              reject(new Error('smee-client not installed — run: npm install -g smee-client'))
            } else {
              reject(err)
            }
          })
          smeeProc.on('exit', () => resolve())
        })
      } catch (err) {
        board.stop()
        console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
        server.close(() => process.exit(1))
        return
      }

      if (!running) break
      currentTunnelProc = null
      board.setTunnel('smee', channelUrl, false)
      bLog(chalk.yellow(`smee relay exited — reconnecting in ${smeeRetryDelay / 1000}s`))
      fileLog({ level: 'warn', event: 'tunnel_closed', reconnecting: true, backend: 'smee' })
      await new Promise(r => setTimeout(r, smeeRetryDelay))
      smeeRetryDelay = Math.min(smeeRetryDelay * 2, 60_000)
      board.setTunnel('smee', channelUrl, true)
    }
    return
  }

  // ── localhost.run mode ────────────────────────────────────────────────────
  let reconnectDelay = 5_000
  while (running) {
    board.setTunnel('localhost.run', null, false)
    let tunnelUrl: string
    let tunnelProc: ChildProcess
    try {
      ;({ url: tunnelUrl, proc: tunnelProc } = await openTunnel(config.server.port))
    } catch (err: unknown) {
      if (!running) break
      const msg = err instanceof Error ? err.message : String(err)
      bLog(chalk.yellow(`tunnel failed: ${msg} — retrying in ${reconnectDelay / 1000}s`))
      fileLog({ level: 'warn', event: 'tunnel_error', message: msg })
      await new Promise(r => setTimeout(r, reconnectDelay))
      reconnectDelay = Math.min(reconnectDelay * 2, 60_000)
      continue
    }
    reconnectDelay = 5_000  // reset backoff on success

    currentTunnelProc = tunnelProc
    board.setTunnel('localhost.run', tunnelUrl, true)
    fileLog({ level: 'info', event: 'tunnel_opened', url: tunnelUrl })

    // Register webhooks for this tunnel session
    const webhookUrl = `${tunnelUrl}${webhookPath}`
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
        bLog(`${chalk.green('✓')} webhook registered: ${chalk.cyan(label)}`)
        fileLog({ level: 'info', event: 'webhook_registered', scope: label, url: webhookUrl })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        const isCreds = /bad credentials|\[401\]/i.test(msg)
        const isScope = /admin:org|write:org|forbidden|\[403\]|must have admin|resource not accessible/i.test(msg)
          || ('org' in scope && /\[404\]/i.test(msg))
        bLog(`${chalk.yellow('⚠')} webhook failed: ${chalk.yellow(label)}`)
        if (isCreds) {
          bLog(`  token invalid — run: ${chalk.cyan('gh auth refresh')}`)
        } else if (isScope) {
          bLog(`  missing admin:org_hook scope — run: ${chalk.cyan('gh auth refresh -s admin:org_hook')}`)
        } else {
          bLog(`  ${msg}`)
        }
        bLog(`  manual Payload URL: ${chalk.cyan(webhookUrl)}`)
      }
    }

    // Wait for this tunnel session to end.
    // Health check kills the SSH proc if lhr.life goes dead without exiting.
    await waitForTunnelEnd(tunnelProc, tunnelUrl)

    if (!running) break

    // Clean up webhooks tied to the old URL before reconnecting
    await deleteCurrentWebhooks()
    board.setTunnel('localhost.run', tunnelUrl, false)
    bLog(chalk.yellow('tunnel disconnected — reconnecting in 5s...'))
    fileLog({ level: 'warn', event: 'tunnel_closed', reconnecting: true })
    await new Promise(r => setTimeout(r, reconnectDelay))
  }
}
