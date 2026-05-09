import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'
import chalk from 'chalk'
import ora from 'ora'
import { createGithubClient, postReviewComment } from '../github/client.js'
import { detectPROrigin, assignReviewer } from '../github/detector.js'
import { runCodexReview } from '../reviewers/codex.js'
import { runClaudeReview } from '../reviewers/claude.js'
import { loadConfig, getGithubToken } from '../config/loader.js'
import { initLogger, log as fileLog, logError } from '../lib/logger.js'
import { parseVerdict, formatVerdict, prependVerdictToComment, NULL_VERDICT_WARNING } from '../lib/verdict.js'

function parsePRUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (!m) return null
  return { owner: m[1], repo: m[2], number: parseInt(m[3], 10) }
}

export async function runReview(prUrl: string, configPath?: string, forceReviewer?: string) {
  const config = loadConfig(configPath)
  initLogger(config.logs)
  fileLog({ level: 'info', event: 'session_start', command: 'review', pr_url: prUrl })

  let token: string
  try {
    token = getGithubToken()
  } catch (err) {
    logError({ command: 'review', phase: 'auth' }, err)
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }

  const octokit = createGithubClient(token)

  const parsed = parsePRUrl(prUrl)
  if (!parsed) {
    console.error(chalk.red('Invalid PR URL. Expected: https://github.com/owner/repo/pull/123'))
    process.exit(1)
  }
  const { owner, repo, number } = parsed

  const spinner = ora(`Fetching PR #${number}...`).start()
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: number })
  spinner.succeed(`PR #${number}: ${pr.title}`)
  fileLog({ level: 'info', event: 'pr_received', repo: `${owner}/${repo}`, pr: number, sha: pr.head.sha })

  let reviewer: 'claude' | 'codex' | null

  if (forceReviewer === 'codex' || forceReviewer === 'claude') {
    reviewer = forceReviewer
    console.log(chalk.dim(`  reviewer: ${reviewer} (forced)`))
  } else {
    const origin = detectPROrigin(pr.body ?? '', config, pr.user?.login)
    reviewer = await assignReviewer(origin, config)
    if (!reviewer) {
      console.log(chalk.dim(`  PR origin: ${origin} — no reviewer assigned (use --reviewer codex|claude to force)`))
      return
    }
    console.log(chalk.dim(`  PR origin: ${origin} → assigned reviewer: ${reviewer}`))
  }

  // Clone the repo into a temp dir
  const tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-repo-'))
  const spinner2 = ora('Cloning repo for review...').start()

  try {
    execSync(`gh repo clone ${owner}/${repo} ${tmpDir} -- --depth=50 --quiet`, { stdio: 'pipe', env: { ...process.env, GITHUB_TOKEN: token, GH_TOKEN: token } })
    execSync(`git fetch origin pull/${number}/head:pr-${number}`, { cwd: tmpDir, stdio: 'pipe' })
    execSync(`git checkout pr-${number}`, { cwd: tmpDir, stdio: 'pipe' })
    try {
      execSync(`git fetch origin ${pr.base.ref}:${pr.base.ref}`, { cwd: tmpDir, stdio: 'pipe' })
    } catch {
      fileLog({ level: 'warn', event: 'base_branch_fetch_skipped', repo: `${owner}/${repo}`, pr: number, base: pr.base.ref })
    }
    spinner2.succeed('Repo ready')

    let reviewText: string
    const reviewStart = Date.now()
    fileLog({ level: 'info', event: 'review_started', repo: `${owner}/${repo}`, pr: number, reviewer })
    let elapsed = 0
    const reviewSpinner = ora(`Running ${reviewer} review...`).start()
    const elapsedTimer = setInterval(() => { elapsed++; reviewSpinner.text = `Running ${reviewer} review... (${elapsed}s)` }, 1000)

    try {
      if (reviewer === 'codex') {
        reviewText = await runCodexReview(
          tmpDir,
          pr.base.ref,
          pr.title,
          config.quality,
          config.vendors.codex,
          undefined,
          msg => { reviewSpinner.text = msg },
        )
      } else {
        reviewText = await runClaudeReview(
          tmpDir,
          pr.base.ref,
          pr.title,
          config.quality,
          config.vendors.claude,
          config.budget.per_review_usd,
          undefined,
          msg => { reviewSpinner.text = msg },
        )
      }
    } finally {
      clearInterval(elapsedTimer)
    }

    reviewSpinner.succeed(`Review complete (${elapsed}s)`)
    const { verdict, clean } = parseVerdict(reviewText)
    if (verdict === null) {
      fileLog({ level: 'warn', event: 'verdict_parse_failed', repo: `${owner}/${repo}`, pr: number, reviewer, output_length: reviewText.length })
    }
    fileLog({ level: 'info', event: 'review_complete', repo: `${owner}/${repo}`, pr: number, reviewer, verdict: verdict ?? undefined, duration_ms: Date.now() - reviewStart })
    console.log(`  ${formatVerdict(verdict)}`)
    const commentBody = verdict === null
      ? `${NULL_VERDICT_WARNING}\n\n${clean}`
      : prependVerdictToComment(clean, verdict)
    await postReviewComment(octokit, owner, repo, number, commentBody, reviewer, config.brand)
    fileLog({ level: 'info', event: 'comment_posted', repo: `${owner}/${repo}`, pr: number, url: prUrl })
    console.log(chalk.green(`\n✓ Review posted to ${prUrl}\n`))

  } catch (err: unknown) {
    logError({ repo: `${owner}/${repo}`, pr: number, phase: 'review' }, err)
    throw err
  } finally {
    rmSync(tmpDir, { force: true, recursive: true })
  }
}
