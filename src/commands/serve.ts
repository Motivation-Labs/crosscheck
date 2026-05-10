import { mkdtempSync, rmSync } from 'fs'
import { tmpdir, hostname } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'
import chalk from 'chalk'
import { findAvailablePort } from '../lib/port.js'
import { createWebhookServer, type PREvent } from '../github/webhook.js'
import { checkRepoAccessible } from '../github/client.js'
import { scanUnreviewedPRs, buildScopesFromConfig } from '../lib/backtrace.js'
import { detectOriginFull, assignReviewer } from '../github/detector.js'
import {
  loadConfig,
  getGithubToken,
  getWebhookSecret,
  resolveConfigPath,
  promptDeploymentMode,
  detectScopesForDeployment,
  patchDeploymentConfig,
} from '../config/loader.js'
import { randomFortune } from '../lib/fortune.js'
import { initLogger, log as fileLog, logError, logUncaught } from '../lib/logger.js'
import { isAuthorAllowed } from '../lib/filter.js'
import { runWorkflow } from '../lib/runner.js'
import { loadWorkflow } from '../lib/workflow.js'
import { PRBoard } from '../lib/board.js'

// Deduplication — keyed by owner/repo#pr@sha
const inFlight = new Set<string>()
// SHAs pushed by the address step — skip synchronize events from our own commits
const crosscheckShas = new Set<string>()

const NOISE_EXT = /\.(lock|snap|min\.js|min\.css|csv|json|png|jpg|jpeg|gif|svg|mp4|woff2?|ttf|eot|ico|pdf)$/i

function computePRLoc(tmpDir: string, baseBranch: string): number {
  try {
    const stat = execSync(`git diff --stat origin/${baseBranch}...HEAD`, { cwd: tmpDir, encoding: 'utf8' })
    let total = 0
    for (const line of stat.split('\n')) {
      const m = line.match(/^\s+(.+?)\s+\|\s+(\d+)/)
      if (!m) continue
      const file = m[1].trim().replace(/\{.*?=> /, '').replace('}', '')
      if (!NOISE_EXT.test(file)) total += parseInt(m[2], 10)
    }
    return total
  } catch {
    return 0
  }
}

async function handlePR(event: PREvent, config: ReturnType<typeof loadConfig>, token: string, board: PRBoard) {
  const { pull_request: pr, repository: repo } = event
  const owner = repo.owner.login
  const repoName = repo.name
  const prNumber = event.number
  const key = `${owner}/${repoName}#${prNumber}@${pr.head.sha}`

  if (inFlight.has(key)) {
    fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'duplicate' })
    return
  }

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

  const { origin, method: originMethod } = await detectOriginFull(
    pr.body ?? '', pr.head.ref,
    owner, repoName, prNumber,
    config, token, pr.user.login,
  )
  const reviewer = await assignReviewer(origin, config)

  fileLog({ level: 'info', event: 'pr_received', repo: `${owner}/${repoName}`, pr: prNumber, sha: pr.head.sha, action: event.action, origin, origin_method: originMethod, author })

  const ts = chalk.dim(new Date().toLocaleTimeString())
  const tsIndent = ' '.repeat(new Date().toLocaleTimeString().length + 2)

  if (!reviewer) {
    board.log(
      `${ts}  PR #${prNumber} ${event.action}  ${chalk.dim(pr.title)}`,
      `${tsIndent}origin=${chalk.yellow(origin)}  via=${chalk.dim(originMethod)}  no reviewer — skipping`,
    )
    inFlight.delete(key)
    return
  }

  board.log(
    `${ts}  PR #${prNumber} ${event.action}  ${chalk.dim(pr.title)}`,
    `${tsIndent}origin=${chalk.yellow(origin)}  via=${chalk.dim(originMethod)}  reviewer=${chalk.cyan(reviewer)}`,
  )

  board.addPR(key, prNumber, `${owner}/${repoName}`, pr.head.ref)
  const reviewStart = Date.now()
  const tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-repo-'))

  try {
    execSync(`gh repo clone ${owner}/${repoName} ${tmpDir} -- --depth=50 --quiet`, { stdio: 'pipe', env: { ...process.env, GITHUB_TOKEN: token, GH_TOKEN: token } })
    execSync(`git fetch origin pull/${prNumber}/head:pr-${prNumber}`, { cwd: tmpDir, stdio: 'pipe' })
    execSync(`git checkout pr-${prNumber}`, { cwd: tmpDir, stdio: 'pipe' })
    try {
      execSync(`git fetch origin ${pr.base.ref}:refs/remotes/origin/${pr.base.ref}`, { cwd: tmpDir, stdio: 'pipe' })
    } catch {
      fileLog({ level: 'warn', event: 'base_branch_fetch_skipped', repo: `${owner}/${repoName}`, pr: prNumber, base: pr.base.ref })
    }

    const prLoc = computePRLoc(tmpDir, pr.base.ref)
    board.updatePR(key, { prLoc })

    await runWorkflow({
      owner, repoName, prNumber, pr,
      tmpDir, token, config, origin,
      reviewStart,
      log: (msg: string) => board.log(`${chalk.dim(new Date().toLocaleTimeString())}  ${msg}`),
      onPhaseChange: (label, data) => board.updatePR(key, { label, ...data }),
      crosscheckShas,
    })

    board.completePR(key, {
      elapsedMs: Date.now() - reviewStart,
      url: `github.com/${owner}/${repoName}/pull/${prNumber}`,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : (err as { message?: string }).message ?? 'unknown error'
    board.failPR(key, message)
    logError({ repo: `${owner}/${repoName}`, pr: prNumber, phase: 'review' }, err)
  } finally {
    rmSync(tmpDir, { force: true, recursive: true })
    inFlight.delete(key)
  }
}

export interface ServeOpts {
  config?: string
  personal?: boolean
  team?: boolean
  reconfigure?: boolean
  backtrace?: boolean
}

export async function runServe(opts: ServeOpts = {}) {
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
    logError({ command: 'serve', phase: 'auth' }, err)
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }

  fileLog({ level: 'info', event: 'session_start', command: 'serve' })

  const board = new PRBoard()
  board.setConfig(config, loadWorkflow(process.cwd()))

  // ── Deployment setup ─────────────────────────────────────────────────────
  let effectiveDeployment: 'personal' | 'team' | undefined = config.deployment
  let sessionOnly = false

  if (opts.personal || opts.team) {
    effectiveDeployment = opts.personal ? 'personal' : 'team'
    sessionOnly = true
    const detected = await detectScopesForDeployment(effectiveDeployment, token)
    config = { ...config, users: detected.users, orgs: detected.orgs, repos: [] }
  } else if (opts.reconfigure || !config.deployment) {
    effectiveDeployment = await promptDeploymentMode(opts.reconfigure ? config.deployment : undefined)
    const cfgPath = resolveConfigPath(configPath) ?? join(process.cwd(), 'crosscheck.config.yml')
    const detected = await detectScopesForDeployment(effectiveDeployment, token)
    patchDeploymentConfig(cfgPath, effectiveDeployment, detected.login, detected.orgs, !!opts.reconfigure)
    config = loadConfig(configPath)
    console.log(`\n  ${chalk.green('✓')} deployment set to ${chalk.cyan(effectiveDeployment)} ${chalk.dim(`(saved to ${cfgPath})`)}`)
  }

  // ── Repo accessibility validation ─────────────────────────────────────────
  const repoChecks = await Promise.all(
    config.repos.map(async ({ owner, name }) => ({
      owner, name,
      ok: await checkRepoAccessible(owner, name, token).catch(() => false),
    }))
  )
  for (const { owner, name, ok } of repoChecks) {
    if (!ok) {
      console.log(chalk.yellow(`  ✗ repo not accessible: ${owner}/${name} — skipped`))
      fileLog({ level: 'warn', event: 'repo_inaccessible', repo: `${owner}/${name}` })
    }
  }

  const webhookSecret = getWebhookSecret()

  const server = createWebhookServer(
    config,
    webhookSecret,
    (event) => { void handlePR(event, config, token, board) },
    (msg: string) => board.log(chalk.dim(new Date().toLocaleTimeString()) + '  ' + msg),
    fileLog,
  )

  let effectivePort: number
  try {
    effectivePort = await findAvailablePort(config.server.port)
  } catch (err) {
    console.error(chalk.red(`\n✗ ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }

  if (effectivePort !== config.server.port) {
    console.log(chalk.yellow(`  ⚠  Port ${config.server.port} in use — using port ${effectivePort} instead`))
    config = { ...config, server: { ...config.server, port: effectivePort } }
  }

  server.listen(effectivePort, () => {
    const webhookUrl = `http://${hostname()}:${effectivePort}${config.server.webhook_path}`
    console.log(chalk.dim(`\n  "${randomFortune()}"\n`))
    console.log(chalk.bold('crosscheck serving\n'))
    console.log(chalk.yellow('  ⚠  serve is in beta — report issues at github.com/Motivation-Labs/crosscheck/issues\n'))
    if (effectiveDeployment) {
      const label = sessionOnly
        ? chalk.dim(`${effectiveDeployment} (session only — not saved)`)
        : chalk.cyan(effectiveDeployment)
      console.log(`  deployment  ${label}`)
    }
    if (config.orgs.length > 0) {
      console.log(`  orgs        ${chalk.cyan(config.orgs.join(', '))}`)
    }
    console.log(`  mode        ${chalk.cyan(config.mode)}`)
    console.log(`  quality     ${chalk.cyan(config.quality.tier)}`)
    console.log(`  port        ${chalk.cyan(String(config.server.port))}`)
    console.log(`  endpoint    ${chalk.cyan(webhookUrl)}`)
    const cfgPath = resolveConfigPath(configPath)
    console.log(`  config      ${chalk.dim(cfgPath ?? 'none (using defaults)')}`)
    if (effectiveDeployment === 'team' && config.routing.allowed_authors.length === 0) {
      console.log(`  authors     ${chalk.dim('all PRs (team mode)')}`)
    } else if (config.routing.allowed_authors.length > 0) {
      console.log(`  authors     ${chalk.cyan(config.routing.allowed_authors.join(', '))}`)
    } else {
      console.log()
      console.log(`  ${chalk.yellow('⚠')}  ${chalk.yellow('No author filter set — all PRs in monitored orgs/repos will be reviewed.')}`)
      console.log(`     ${chalk.dim('Run')} ${chalk.cyan('crosscheck serve --reconfigure')} ${chalk.dim('to set up a deployment mode.')}`)
    }
    console.log()
    console.log(chalk.dim('Register the endpoint above as a GitHub webhook (content-type: application/json).'))
    if (config.orgs.length > 0) {
      for (const org of config.orgs) {
        console.log(chalk.dim(`  → https://github.com/organizations/${org}/settings/hooks`))
      }
    }
    console.log(chalk.dim('Listening for pull_request events...\n'))

    // Backtrace: find open PRs that haven't been reviewed yet
    if (opts.backtrace === false) {
      board.log('backtrace skipped (--no-backtrace flag)')
    } else if (config.backtrace.enabled) {
      void (async () => {
        try {
          board.log('backtrace: scanning open PRs in monitored scope...')
          fileLog({ level: 'info', event: 'backtrace_start' })
          const backtraceScopes = await buildScopesFromConfig(config, token)
          const { queued, alreadyReviewed, skippedAuthor } = await scanUnreviewedPRs(backtraceScopes, config, token)
          if (queued.length === 0) {
            board.log('backtrace: no unreviewed open PRs found')
          } else {
            const parts = [`${queued.length} PR${queued.length !== 1 ? 's' : ''} queued`]
            if (alreadyReviewed > 0) parts.push(`${alreadyReviewed} already reviewed`)
            if (skippedAuthor > 0) parts.push(`${skippedAuthor} skipped (author filter)`)
            board.log(`backtrace: ${parts.join(', ')}`)
          }
          fileLog({ level: 'info', event: 'backtrace_complete', queued: queued.length, already_reviewed: alreadyReviewed, skipped_author: skippedAuthor })
          void Promise.all(queued.map(pr => handlePR({
            action: 'backtrace',
            number: pr.number,
            pull_request: {
              title: pr.title,
              body: pr.body ?? '',
              head: { ref: pr.headRef, sha: pr.headSha, repo: pr.headRepo ? { full_name: pr.headRepo } : null },
              base: { ref: pr.baseRef, repo: { full_name: `${pr.owner}/${pr.repo}` } },
              html_url: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`,
              user: { login: pr.author },
            },
            repository: {
              name: pr.repo,
              owner: { login: pr.owner },
              clone_url: `https://github.com/${pr.owner}/${pr.repo}.git`,
            },
          }, config, token, board)))
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          board.log(`backtrace: scan failed — ${msg}`)
          fileLog({ level: 'warn', event: 'backtrace_error', message: msg })
        }
      })()
    }


    board.setTunnel('serve', webhookUrl, true)
    board.start()
  })

  process.on('SIGINT', () => {
    board.stop()
    console.log('\nShutting down...')
    fileLog({ level: 'info', event: 'session_end', command: 'serve' })
    server.close(() => process.exit(0))
  })
}
