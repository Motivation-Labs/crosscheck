import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'
import chalk from 'chalk'
import ora from 'ora'
import { createGithubClient } from '../github/client.js'
import { detectPROrigin, assignReviewer } from '../github/detector.js'
import { loadConfig, getGithubToken } from '../config/loader.js'
import { initLogger, log as fileLog, logError } from '../lib/logger.js'
import { runWorkflow } from '../lib/runner.js'
import { loadWorkflow } from '../lib/workflow.js'
import { formatVerdict, type Verdict } from '../lib/verdict.js'
import type { PREvent } from '../github/webhook.js'

export interface RunOpts {
  config?: string
  reviewer?: string
  steps?: string
  dryRun?: boolean
}

function parsePRUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (!m) return null
  return { owner: m[1], repo: m[2], number: parseInt(m[3], 10) }
}

export async function runRun(prUrl: string, opts: RunOpts = {}) {
  const config = loadConfig(opts.config)
  initLogger(config.logs)
  fileLog({ level: 'info', event: 'session_start', command: 'run', pr_url: prUrl })

  let token: string
  try {
    token = getGithubToken()
  } catch (err) {
    logError({ command: 'run', phase: 'auth' }, err)
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }

  const parsed = parsePRUrl(prUrl)
  if (!parsed) {
    console.error(chalk.red('Invalid PR URL. Expected: https://github.com/owner/repo/pull/123'))
    process.exit(1)
  }
  const { owner, repo, number } = parsed

  const spinner = ora(`Fetching PR #${number}...`).start()
  const octokit = createGithubClient(token)
  const { data: prData } = await octokit.rest.pulls.get({ owner, repo, pull_number: number })
  spinner.succeed(`PR #${number}: ${prData.title}`)
  fileLog({ level: 'info', event: 'pr_received', repo: `${owner}/${repo}`, pr: number, sha: prData.head.sha })

  // Resolve origin and reviewer
  let origin: import('../github/detector.js').PROrigin
  if (opts.reviewer === 'codex' || opts.reviewer === 'claude') {
    // --reviewer forces the origin to the opposite vendor (cross-vendor semantics)
    // but we still need an origin value; treat the forced reviewer as the reviewer directly
    origin = opts.reviewer === 'codex' ? 'claude' : 'codex'
    console.log(chalk.dim(`  reviewer: ${opts.reviewer} (forced)`))
  } else {
    origin = detectPROrigin(prData.body ?? '', config, prData.user?.login)
    console.log(chalk.dim(`  PR origin: ${origin}`))
  }

  const assignedReviewer = opts.reviewer === 'codex' || opts.reviewer === 'claude'
    ? opts.reviewer
    : await assignReviewer(origin, config)

  if (!assignedReviewer) {
    console.log(chalk.dim(`  no reviewer assigned for origin "${origin}" — use --reviewer codex|claude to force`))
    return
  }
  if (!opts.reviewer) {
    console.log(chalk.dim(`  assigned reviewer: ${assignedReviewer}`))
  }

  // Resolve steps — filter from workflow.yml by type if --steps is specified
  const allSteps = loadWorkflow(process.cwd())
  const stepFilter = opts.steps?.split(',').map(s => s.trim().toLowerCase())
  const filteredSteps = stepFilter
    ? allSteps.filter(s => stepFilter.includes(s.type) || stepFilter.includes(s.name))
    : allSteps

  if (opts.dryRun) {
    console.log(chalk.dim('  dry-run: review will run but no comment will be posted; fix step skipped'))
  }

  // Build the PREvent['pull_request'] shape from the GitHub API response
  const pr: PREvent['pull_request'] = {
    title: prData.title,
    body: prData.body ?? '',
    head: {
      ref: prData.head.ref,
      sha: prData.head.sha,
      repo: prData.head.repo ? { full_name: prData.head.repo.full_name } : null,
    },
    base: {
      ref: prData.base.ref,
      repo: { full_name: `${owner}/${repo}` },
    },
    html_url: prData.html_url,
    user: { login: prData.user?.login ?? '' },
  }

  // Clone the repo
  const tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-run-'))
  const cloneSpinner = ora('Cloning repo...').start()

  try {
    execSync(
      `gh repo clone ${owner}/${repo} ${tmpDir} -- --depth=50 --quiet`,
      { stdio: 'pipe', env: { ...process.env, GITHUB_TOKEN: token, GH_TOKEN: token } },
    )
    execSync(`git fetch origin pull/${number}/head:pr-${number}`, { cwd: tmpDir, stdio: 'pipe' })
    execSync(`git checkout pr-${number}`, { cwd: tmpDir, stdio: 'pipe' })
    try {
      execSync(
        `git fetch origin ${prData.base.ref}:refs/remotes/origin/${prData.base.ref}`,
        { cwd: tmpDir, stdio: 'pipe' },
      )
    } catch {
      fileLog({ level: 'warn', event: 'base_branch_fetch_skipped', repo: `${owner}/${repo}`, pr: number, base: prData.base.ref })
    }
    cloneSpinner.succeed('Repo ready')

    let activeSpinner = ora('').start()

    const { verdict } = await runWorkflow({
      owner,
      repoName: repo,
      prNumber: number,
      pr,
      tmpDir,
      token,
      config,
      origin,
      reviewStart: Date.now(),
      log: (msg) => { activeSpinner.stop(); console.log(msg); activeSpinner = ora('').start() },
      onPhaseChange: (label) => { activeSpinner.text = label },
      crosscheckShas: new Set(),
      dryRun: opts.dryRun,
      steps: filteredSteps,
    })

    activeSpinner.stop()
    console.log(`\n  ${formatVerdict(verdict as Verdict | null)}`)

    if (!opts.dryRun) {
      console.log(chalk.green(`\n✓ Workflow complete — ${prUrl}\n`))
    } else {
      console.log(chalk.dim(`\n  dry-run complete — no changes posted\n`))
    }

  } catch (err: unknown) {
    logError({ repo: `${owner}/${repo}`, pr: number, phase: 'run' }, err)
    console.error(chalk.red(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`))
    process.exit(2)
  } finally {
    rmSync(tmpDir, { force: true, recursive: true })
  }
}
