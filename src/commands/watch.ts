import { execSync, spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import chalk from 'chalk'
import { createWebhookServer, type PREvent } from '../github/webhook.js'
import {
  registerOrgWebhook,
  deleteOrgWebhook,
  registerRepoWebhook,
  deleteRepoWebhook,
  findOrgWebhook,
  findRepoWebhook,
  listUserRepos,
  checkRepoAccessible,
} from '../github/client.js'
import { detectOriginFull, assignReviewer } from '../github/detector.js'
import {
  loadConfig,
  getGithubToken,
  getWebhookSecret,
  resolveConfigPath,
  promptDeploymentMode,
  detectScopesForDeployment,
  patchDeploymentConfig,
  detectGitHubLogin,
} from '../config/loader.js'
import { randomFortune } from '../lib/fortune.js'
import { scanUnreviewedPRs } from '../lib/backtrace.js'
import { initLogger, log as fileLog, logError, logUncaught } from '../lib/logger.js'
import { isAuthorAllowed } from '../lib/filter.js'
import { runWorkflow } from '../lib/runner.js'
import { loadWorkflow } from '../lib/workflow.js'
import { PRBoard, fmtTime, FMT_TIME_WIDTH } from '../lib/board.js'
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

export interface WatchOpts {
  config?: string
  personal?: boolean
  team?: boolean
  reconfigure?: boolean
  backtrace?: boolean
}

export async function runWatch(opts: WatchOpts = {}) {
  const configPath = opts.config
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

  // Connectivity events (tunnel/webhook) go into the live connectivity section
  const cLog = (line: string) => {
    board.logConnectivity(line)
    fileLog({ level: 'info', event: 'message', message: line })
  }

  // PR deduplication — skip if already reviewing this PR+SHA
  const inFlight = new Set<string>()
  // SHAs pushed by the address step — skip synchronize events from our own commits
  const crosscheckShas = new Set<string>()

  async function reviewPR(params: {
    owner: string; repoName: string; prNumber: number; title: string;
    body: string | null; author: string; headSha: string; headRef: string;
    headRepo: string | null; baseRef: string; action: string;
  }): Promise<void> {
    const { owner, repoName, prNumber } = params
    const key = `${owner}/${repoName}#${prNumber}@${params.headSha}`
    if (inFlight.has(key)) return
    inFlight.add(key)

    // Outer try/finally ensures the inFlight key is always released, even if
    // detectOriginFull / assignReviewer throw before the inner try block starts.
    try {
      if (!isAuthorAllowed(config.routing.allowed_authors, params.author)) {
        fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'author_not_allowed', author: params.author })
        return
      }

      const { origin, method: originMethod } = await detectOriginFull(
        params.body ?? '', params.headRef,
        owner, repoName, prNumber,
        config, token, params.author,
      )
      const reviewer = await assignReviewer(origin, config)

      fileLog({ level: 'info', event: 'pr_received', repo: `${owner}/${repoName}`, pr: prNumber, sha: params.headSha, action: params.action, origin, origin_method: originMethod, author: params.author })

      if (!reviewer) {
        fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'no_reviewer', origin })
        return
      }

      const ts = chalk.dim(fmtTime())
      const tsIndent = ' '.repeat(FMT_TIME_WIDTH + 2)
      bLog(
        `${ts}  PR #${prNumber} ${params.action}  ${chalk.dim(params.title)}`,
        `${tsIndent}origin=${chalk.yellow(origin)}  via=${chalk.dim(originMethod)}  reviewer=${chalk.cyan(reviewer)}`
      )

      const pr: PREvent['pull_request'] = {
        title: params.title,
        body: params.body ?? '',
        head: { ref: params.headRef, sha: params.headSha, repo: params.headRepo ? { full_name: params.headRepo } : null },
        base: { ref: params.baseRef, repo: { full_name: `${owner}/${repoName}` } },
        html_url: `https://github.com/${owner}/${repoName}/pull/${prNumber}`,
        user: { login: params.author },
      }

      board.addPR(key, prNumber, `${owner}/${repoName}`, params.headRef)
      const reviewStart = Date.now()
      const tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-repo-'))

      try {
        // Bypass `gh repo clone` so gh's keyring auth (which may bridge to VS Code's
        // GitHub extension) is never invoked. HTTPS embeds the token in the URL.
        const cloneUrl = config.clone_protocol === 'https'
          ? `https://x-access-token:${token}@github.com/${owner}/${repoName}.git`
          : `git@github.com:${owner}/${repoName}.git`
        execSync(`git clone --depth=50 --quiet ${cloneUrl} ${tmpDir}`, { stdio: 'pipe' })
        execSync(`git fetch origin pull/${prNumber}/head:pr-${prNumber}`, { cwd: tmpDir, stdio: 'pipe' })
        execSync(`git checkout pr-${prNumber}`, { cwd: tmpDir, stdio: 'pipe' })
        // Fetch the base branch after checking out the PR branch so we are never
        // on the base branch during the fetch (git refuses to update a checked-out ref).
        // Use explicit refs/remotes/origin/<base> target so the remote-tracking ref is
        // always created — `git fetch origin <branch>` alone only writes FETCH_HEAD in
        // shallow clones when the branch is absent from the default refspec mapping.
        try {
          execSync(`git fetch origin ${params.baseRef}:refs/remotes/origin/${params.baseRef}`, { cwd: tmpDir, stdio: 'pipe' })
        } catch {
          fileLog({ level: 'warn', event: 'base_branch_fetch_skipped', repo: `${owner}/${repoName}`, pr: prNumber, base: params.baseRef })
        }

        const prLoc = computePRLoc(tmpDir, params.baseRef)
        board.updatePR(key, { prLoc })

        const { verdict } = await runWorkflow({
          owner, repoName, prNumber, pr,
          tmpDir, token, config, origin,
          reviewStart,
          log: (msg: string) => bLog(`${chalk.dim(fmtTime())}  ${msg}`),
          onPhaseChange: (label, data) => board.updatePR(key, { label, ...data }),
          crosscheckShas,
        })

        void verdict
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
      }
    } catch (err: unknown) {
      logError({ repo: `${owner}/${repoName}`, pr: prNumber, phase: 'setup' }, err)
    } finally {
      inFlight.delete(key)
    }
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

      await reviewPR({
        owner, repoName, prNumber,
        title: pr.title, body: pr.body, author: pr.user.login,
        headSha: pr.head.sha, headRef: pr.head.ref, headRepo: pr.head.repo?.full_name ?? null,
        baseRef: pr.base.ref, action: event.action,
      })
    },
    (msg: string) => bLog(chalk.dim(fmtTime()) + '  ' + msg),
    fileLog,
  )

  await new Promise<void>((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(
          `Port ${config.server.port} is already in use.\n` +
          `  Another crosscheck watch instance is likely running on this port.\n` +
          `  Stop it first — running two instances against the same scopes will\n` +
          `  register duplicate webhooks and post duplicate reviews.\n` +
          `  To run intentionally on a different port, change it in config:\n` +
          `    server:\n      port: ${config.server.port + 1}`
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

  // ── Deployment setup ─────────────────────────────────────────────────────
  // Runs before scope building so detected users/orgs feed into webhook registration.
  let effectiveDeployment: 'personal' | 'team' | undefined = config.deployment
  let sessionOnly = false
  let selfLogin: string | null = null

  if (opts.personal || opts.team) {
    // One-time flag: auto-detect scopes for this session, no config write.
    effectiveDeployment = opts.personal ? 'personal' : 'team'
    sessionOnly = true
    const detected = await detectScopesForDeployment(effectiveDeployment, token)
    selfLogin = detected.login
    config = { ...config, users: detected.users, orgs: detected.orgs, repos: [] }
  } else if (opts.reconfigure || !config.deployment) {
    // First run (no deployment in config) or explicit --reconfigure.
    effectiveDeployment = await promptDeploymentMode(opts.reconfigure ? config.deployment : undefined)
    const cfgPath = resolveConfigPath(configPath) ?? join(process.cwd(), 'crosscheck.config.yml')
    const detected = await detectScopesForDeployment(effectiveDeployment, token)
    selfLogin = detected.login
    // force=true only for --reconfigure; first-run preserves any manually-configured orgs/authors
    patchDeploymentConfig(cfgPath, effectiveDeployment, detected.login, detected.orgs, !!opts.reconfigure)
    config = loadConfig(configPath)
    console.log(`\n  ${chalk.green('✓')} deployment set to ${chalk.cyan(effectiveDeployment)} ${chalk.dim(`(saved to ${cfgPath})`)}`)
  }

  // ── Scope building ────────────────────────────────────────────────────────
  // Determine scopes once — these don't change between tunnel reconnects.
  // orgs, users, and repos are additive: all configured sources contribute scopes.
  type Scope = { org: string } | { owner: string; repo: string }
  const scopes: Scope[] = []

  for (const org of config.orgs) scopes.push({ org })

  const userRepoResults: Array<{ user: string; count: number } | { user: string; error: string }> = []
  if (config.users.length > 0) {
    // selfLogin is known when we just ran detection; fall back to detectGitHubLogin() for
    // existing configs so personal-mode users still get private repos enumerated.
    if (!selfLogin) selfLogin = detectGitHubLogin()
    for (const user of config.users) {
      try {
        const repos = await listUserRepos(user, token, user === selfLogin)
        for (const { owner, name } of repos) scopes.push({ owner, repo: name })
        userRepoResults.push({ user, count: repos.length })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        userRepoResults.push({ user, error: msg })
      }
    }
  }

  // Validate explicitly-configured repos and skip any that are inaccessible.
  const repoChecks = await Promise.all(
    config.repos.map(async ({ owner, name }) => ({
      owner, name,
      ok: await checkRepoAccessible(owner, name, token).catch(() => false),
    }))
  )
  for (const { owner, name, ok } of repoChecks) {
    if (ok) {
      scopes.push({ owner, repo: name })
    } else {
      console.log(chalk.yellow(`  ✗ repo not accessible: ${owner}/${name} — skipped`))
      fileLog({ level: 'warn', event: 'repo_inaccessible', repo: `${owner}/${name}` })
    }
  }

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
  if (effectiveDeployment) {
    const deployLabel = sessionOnly
      ? chalk.dim(`${effectiveDeployment} (session only — not saved)`)
      : chalk.cyan(effectiveDeployment)
    console.log(`  profile     ${deployLabel} · ${chalk.cyan(config.mode)} · ${chalk.cyan(config.quality.tier)}`)
  } else {
    console.log(`  profile     ${chalk.cyan(config.mode)} · ${chalk.cyan(config.quality.tier)}`)
  }
  if (config.orgs.length > 0) {
    console.log(`  orgs        ${chalk.cyan(config.orgs.join(', '))}`)
  }
  if (config.users.length > 0) {
    const userParts = userRepoResults.map(r => {
      if ('error' in r) return chalk.yellow(`${r.user} (⚠ list failed)`)
      return `${chalk.cyan(r.user)} ${chalk.dim(`(${r.count} repos)`)}`
    })
    console.log(`  users       ${userParts.join(', ')}`)
  }
  if (config.orgs.length === 0 && config.users.length === 0) {
    const labels = scopes.map(s => 'org' in s ? s.org : `${s.owner}/${s.repo}`)
    console.log(`  repos       ${chalk.cyan(labels.join(', '))}`)
  }
  const cfgPath = resolveConfigPath(configPath)
  console.log(`  config      ${chalk.dim(cfgPath ?? 'none (using defaults)')}  ${chalk.dim('← edit to change above')}`)
  if (effectiveDeployment === 'team' && config.routing.allowed_authors.length === 0) {
    console.log(`  authors     ${chalk.dim('all PRs (team mode)')}`)
  } else if (config.routing.allowed_authors.length > 0) {
    console.log(`  authors     ${chalk.cyan(config.routing.allowed_authors.join(', '))}`)
  } else {
    console.log()
    console.log(`  ${chalk.yellow('⚠')}  ${chalk.yellow('No author filter set — all PRs in monitored orgs/repos will be reviewed.')}`)
    console.log(`     ${chalk.dim('Run')} ${chalk.cyan('crosscheck watch --reconfigure')} ${chalk.dim('to set up a deployment mode.')}`)
  }
  console.log()

  // Board starts after the banner — all output below is live-updated
  board.start()

  // ── Backtrace scan ────────────────────────────────────────────────────────
  if (opts.backtrace === true || (opts.backtrace !== false && config.backtrace.enabled)) {
    void (async () => {
      try {
        cLog(`${chalk.dim('✦')} backtrace: scanning open PRs in monitored scope...`)
        const { queued, alreadyReviewed, skippedAuthor } = await scanUnreviewedPRs(scopes, config, token)
        cLog(`${chalk.dim('✦')} backtrace: ${queued.length} unreviewed, ${alreadyReviewed} already reviewed, ${skippedAuthor} skipped (author filter)`)
        void Promise.all(queued.map(pr => reviewPR({
          owner: pr.owner, repoName: pr.repo, prNumber: pr.number,
          title: pr.title, body: pr.body, author: pr.author,
          headSha: pr.headSha, headRef: pr.headRef, headRepo: pr.headRepo,
          baseRef: pr.baseRef, action: 'backtrace',
        })))
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        cLog(`${chalk.yellow('⚠')} backtrace: scan failed — ${msg}`)
      }
    })()
  }

  // ── Smee mode ─────────────────────────────────────────────────────────────
  // Smee channel URL is stable — webhooks are registered once and survive restarts.
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

    // Register webhooks pointing at the smee channel URL (idempotent — skip if already set).
    // The smee channel URL never changes, so this survives restarts without creating duplicates.
    let smeeOk = 0, smeeFail = 0
    const smeeFailuresByReason = new Map<string, { labels: string[]; msg: string }>()
    for (const scope of scopes) {
      const label = 'org' in scope ? scope.org : `${scope.owner}/${scope.repo}`
      try {
        let existing: number | null
        if ('org' in scope) {
          existing = await findOrgWebhook(scope.org, channelUrl, token)
          if (!existing) await registerOrgWebhook(scope.org, channelUrl, webhookSecret, token)
        } else {
          existing = await findRepoWebhook(scope.owner, scope.repo, channelUrl, token)
          if (!existing) await registerRepoWebhook(scope.owner, scope.repo, channelUrl, webhookSecret, token)
        }
        smeeOk++
        fileLog({ level: 'info', event: existing ? 'webhook_active' : 'webhook_registered', scope: label, url: channelUrl })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        const isCreds = /bad credentials|\[401\]/i.test(msg)
        const isScope = /admin:org|write:org|forbidden|\[403\]|must have admin|resource not accessible/i.test(msg)
          || ('org' in scope && /\[404\]/i.test(msg))
        const reason = isCreds ? 'creds' : isScope ? 'scope' : `other:${msg}`
        smeeFail++
        const bucket = smeeFailuresByReason.get(reason)
        if (bucket) { bucket.labels.push(label) } else { smeeFailuresByReason.set(reason, { labels: [label], msg }) }
        fileLog({ level: 'warn', event: 'webhook_error', scope: label, message: msg })
      }
    }

    // Grouped failure summary — one block per error type
    for (const [reason, { labels, msg }] of smeeFailuresByReason) {
      const count = labels.length
      const shown = labels.slice(0, 5)
      const overflow = count - shown.length
      const sample = shown.join(', ') + (overflow > 0 ? ` +${overflow} more` : '')
      const noun = count === 1 ? 'webhook' : 'webhooks'
      if (reason === 'creds') {
        cLog(`${chalk.yellow('⚠')} ${count} ${noun} failed: token invalid — run: ${chalk.cyan('gh auth refresh')}`)
      } else if (reason === 'scope') {
        cLog(`${chalk.yellow('⚠')} ${count} ${noun} failed: missing scope — run: ${chalk.cyan('gh auth refresh -s admin:org_hook')}`)
      } else {
        cLog(`${chalk.yellow('⚠')} ${count} ${noun} failed: ${msg}`)
      }
      cLog(`  ${chalk.dim(sample)}`)
    }
    const smeeTotal = scopes.length
    cLog(`${smeeFail === 0 ? chalk.green('✓') : chalk.yellow('⚠')} webhooks registered: ${smeeOk}/${smeeTotal}${smeeFail > 0 ? ` (${smeeFail} failed)` : ''}`)

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
      cLog(chalk.yellow(`smee relay exited — reconnecting in ${smeeRetryDelay / 1000}s`))
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
      cLog(chalk.yellow(`tunnel failed: ${msg} — retrying in ${reconnectDelay / 1000}s`))
      fileLog({ level: 'warn', event: 'tunnel_error', message: msg })
      await new Promise(r => setTimeout(r, reconnectDelay))
      reconnectDelay = Math.min(reconnectDelay * 2, 60_000)
      continue
    }
    reconnectDelay = 5_000  // reset backoff on success

    currentTunnelProc = tunnelProc
    board.setTunnel('localhost.run', tunnelUrl, true)
    cLog(`${chalk.green('✓')} tunnel ready: ${chalk.cyan(tunnelUrl)}`)
    fileLog({ level: 'info', event: 'tunnel_opened', url: tunnelUrl })

    // Register webhooks in parallel: dedup check → register with backoff → aggregate summary
    const webhookUrl = `${tunnelUrl}${webhookPath}`
    currentRegistered = []
    let hookOk = 0, hookFail = 0
    const failuresByReason = new Map<string, { labels: string[]; msg: string }>()

    await Promise.all(scopes.map(async (scope) => {
      const label = 'org' in scope ? scope.org : `${scope.owner}/${scope.repo}`

      // Dedup: skip if a hook for this exact URL already exists (e.g. previous session not cleaned up)
      let existingId: number | null = null
      try {
        existingId = 'org' in scope
          ? await findOrgWebhook(scope.org, webhookUrl, token)
          : await findRepoWebhook(scope.owner, scope.repo, webhookUrl, token)
      } catch { /* ignore — proceed to register */ }

      if (existingId !== null) {
        currentRegistered.push('org' in scope
          ? { type: 'org' as const, org: scope.org, hookId: existingId }
          : { type: 'repo' as const, owner: scope.owner, repo: scope.repo, hookId: existingId })
        hookOk++
        fileLog({ level: 'info', event: 'webhook_active', scope: label, url: webhookUrl })
        return
      }

      // Register with exponential back-off: delay 2s then 4s before giving up
      let hookId: number | null = null
      let lastErr = ''
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          const delay = 2 ** attempt * 1000
          fileLog({ level: 'warn', event: 'webhook_register_retry', scope: label, attempt, message: lastErr })
          await new Promise(r => setTimeout(r, delay))
        }
        try {
          hookId = 'org' in scope
            ? await registerOrgWebhook(scope.org, webhookUrl, webhookSecret, token)
            : await registerRepoWebhook(scope.owner, scope.repo, webhookUrl, webhookSecret, token)
          break
        } catch (err: unknown) {
          lastErr = err instanceof Error ? err.message : String(err)
        }
      }

      if (hookId !== null) {
        currentRegistered.push('org' in scope
          ? { type: 'org' as const, org: scope.org, hookId }
          : { type: 'repo' as const, owner: scope.owner, repo: scope.repo, hookId })
        hookOk++
        fileLog({ level: 'info', event: 'webhook_registered', scope: label, url: webhookUrl })
      } else {
        hookFail++
        const isCreds = /bad credentials|\[401\]/i.test(lastErr)
        const isScope = /admin:org|write:org|forbidden|\[403\]|must have admin|resource not accessible/i.test(lastErr)
          || ('org' in scope && /\[404\]/i.test(lastErr))
        const reason = isCreds ? 'creds' : isScope ? 'scope' : `other:${lastErr}`
        const bucket = failuresByReason.get(reason)
        if (bucket) {
          bucket.labels.push(label)
        } else {
          failuresByReason.set(reason, { labels: [label], msg: lastErr })
        }
        fileLog({ level: 'warn', event: 'webhook_error', scope: label, message: lastErr })
      }
    }))

    // Print grouped failure summary — one block per error type, not one line per repo
    for (const [reason, { labels, msg }] of failuresByReason) {
      const count = labels.length
      const shown = labels.slice(0, 5)
      const overflow = count - shown.length
      const sample = shown.join(', ') + (overflow > 0 ? ` +${overflow} more` : '')
      const noun = count === 1 ? 'webhook' : 'webhooks'
      if (reason === 'creds') {
        bLog(`  ${chalk.yellow('⚠')} ${count} ${noun} failed: token invalid — run: ${chalk.cyan('gh auth refresh')}`)
      } else if (reason === 'scope') {
        bLog(`  ${chalk.yellow('⚠')} ${count} ${noun} failed: missing scope — run: ${chalk.cyan('gh auth refresh -s admin:org_hook')}`)
      } else {
        bLog(`  ${chalk.yellow('⚠')} ${count} ${noun} failed: ${msg}`)
      }
      bLog(`    ${chalk.dim(sample)}`)
      bLog(`  manual Payload URL: ${chalk.cyan(webhookUrl)}`)
    }

    // Single aggregated connectivity line instead of one per repo
    const hookTotal = scopes.length
    cLog(`${hookFail === 0 ? chalk.green('✓') : chalk.yellow('⚠')} webhooks registered: ${hookOk}/${hookTotal}${hookFail > 0 ? ` (${hookFail} failed)` : ''}`)
    fileLog({ level: 'info', event: 'webhooks_registered', count: hookOk, total: hookTotal, failed: hookFail, url: webhookUrl })

    // Wait for this tunnel session to end.
    // Health check kills the SSH proc if lhr.life goes dead without exiting.
    await waitForTunnelEnd(tunnelProc, tunnelUrl)

    if (!running) break

    // Clean up webhooks tied to the old URL before reconnecting
    await deleteCurrentWebhooks()
    board.setTunnel('localhost.run', tunnelUrl, false)
    cLog(chalk.yellow('tunnel disconnected — reconnecting in 5s...'))
    fileLog({ level: 'warn', event: 'tunnel_closed', reconnecting: true })
    await new Promise(r => setTimeout(r, reconnectDelay))
  }
}
