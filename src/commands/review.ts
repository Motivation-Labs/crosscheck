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
import type { Config } from '../config/schema.js'

function parsePRUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (!m) return null
  return { owner: m[1], repo: m[2], number: parseInt(m[3], 10) }
}

export async function runReview(prUrl: string, configPath?: string, forceReviewer?: string) {
  const config = loadConfig(configPath)
  const token = getGithubToken()
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

  let reviewer: 'claude' | 'codex' | null

  if (forceReviewer === 'codex' || forceReviewer === 'claude') {
    reviewer = forceReviewer
    console.log(chalk.dim(`  reviewer: ${reviewer} (forced)`))
  } else {
    const origin = detectPROrigin(pr.body ?? '', config)
    reviewer = assignReviewer(origin, config)
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
    execSync(`gh repo clone ${owner}/${repo} ${tmpDir} -- --depth=50 --quiet`, { stdio: 'pipe' })
    execSync(`git fetch origin pull/${number}/head:pr-${number}`, { cwd: tmpDir, stdio: 'pipe' })
    execSync(`git checkout pr-${number}`, { cwd: tmpDir, stdio: 'pipe' })
    spinner2.succeed('Repo ready')

    let reviewText: string
    const reviewSpinner = ora(`Running ${reviewer} review...`).start()

    if (reviewer === 'codex') {
      reviewText = await runCodexReview(
        tmpDir,
        pr.base.ref,
        pr.title,
        config.quality,
        config.vendors.codex.model,
        config.vendors.codex.auth,
        msg => reviewSpinner.text = msg,
      )
    } else {
      reviewText = await runClaudeReview(
        tmpDir,
        pr.base.ref,
        pr.title,
        config.quality,
        config.vendors.claude,
        config.budget.per_review_usd,
        msg => reviewSpinner.text = msg,
      )
    }

    reviewSpinner.succeed('Review complete')
    await postReviewComment(octokit, owner, repo, number, reviewText, reviewer)
    console.log(chalk.green(`\n✓ Review posted to ${prUrl}\n`))

  } finally {
    rmSync(tmpDir, { force: true, recursive: true })
  }
}
