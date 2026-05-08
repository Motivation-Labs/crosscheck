import { execSync } from 'child_process'
import chalk from 'chalk'
import ora from 'ora'
import type { Config } from '../config/schema.js'
import type { PREvent } from '../github/webhook.js'
import type { PROrigin } from '../github/detector.js'
import { runCodexReview } from '../reviewers/codex.js'
import { runClaudeReview } from '../reviewers/claude.js'
import { runAddressStep } from '../reviewers/address.js'
import { parseVerdict, formatVerdict, prependVerdictToComment } from '../lib/verdict.js'
import { createGithubClient, postReviewComment } from '../github/client.js'
import { log as fileLog, logError } from '../lib/logger.js'
import { loadWorkflow, evaluateWhen, type StepResult } from '../lib/workflow.js'

const MAX_CROSSCHECK_COMMITS = 5

export interface WorkflowContext {
  owner: string
  repoName: string
  prNumber: number
  pr: PREvent['pull_request']
  tmpDir: string
  token: string
  config: Config
  origin: PROrigin
  reviewStart: number
  log: (msg: string) => void
  // SHAs crosscheck pushed — used to skip self-triggered synchronize events
  crosscheckShas: Set<string>
}

function resolveReviewer(
  reviewer: string,
  origin: PROrigin,
  config: Config,
): 'claude' | 'codex' | null {
  if (reviewer === 'origin') {
    if (origin === 'claude' && config.vendors.claude.enabled) return 'claude'
    if (origin === 'codex' && config.vendors.codex.enabled) return 'codex'
    return null
  }
  if (reviewer === 'auto') {
    if (origin === 'claude' && config.vendors.codex.enabled) return 'codex'
    if (origin === 'codex' && config.vendors.claude.enabled) return 'claude'
    if (config.vendors.codex.enabled) return 'codex'
    if (config.vendors.claude.enabled) return 'claude'
    return null
  }
  if (reviewer === 'claude') return config.vendors.claude.enabled ? 'claude' : null
  if (reviewer === 'codex') return config.vendors.codex.enabled ? 'codex' : null
  return null
}

export async function runWorkflow(ctx: WorkflowContext): Promise<void> {
  const { owner, repoName, prNumber, pr, tmpDir, token, config, origin, log } = ctx
  const steps = loadWorkflow(process.cwd())
  const results: Record<string, StepResult> = {}
  const spinner = ora({ indent: 2 })

  for (const step of steps) {
    // Evaluate when condition — skip step if false
    if (step.when && !evaluateWhen(step.when, results)) {
      log(chalk.dim(`  [${step.name}] skipped — ${step.when}`))
      results[step.name] = { skipped: true }
      continue
    }

    if (step.type === 'review' || step.type === 'recheck') {
      const reviewer = resolveReviewer(step.reviewer, origin, config)
      if (!reviewer) {
        log(chalk.dim(`  [${step.name}] no reviewer available — skipping`))
        results[step.name] = { skipped: true }
        continue
      }

      fileLog({ level: 'info', event: 'review_started', repo: `${owner}/${repoName}`, pr: prNumber, reviewer })

      let elapsed = 0
      const timer = setInterval(() => { elapsed++; spinner.text = `${reviewer} reviewing... (${elapsed}s)` }, 1000)
      spinner.start(`${reviewer} reviewing...`)

      let rawReview: string
      try {
        if (reviewer === 'codex') {
          rawReview = await runCodexReview(tmpDir, pr.base.ref, pr.title, config.quality, config.vendors.codex.model, config.vendors.codex.auth)
        } else {
          rawReview = await runClaudeReview(tmpDir, pr.base.ref, pr.title, config.quality, config.vendors.claude, config.budget.per_review_usd)
        }
      } finally {
        clearInterval(timer)
      }

      const { verdict, clean } = parseVerdict(rawReview)
      const commentBody = prependVerdictToComment(clean, verdict)
      spinner.succeed(`${step.type} complete (${elapsed}s)`)
      fileLog({ level: 'info', event: 'review_complete', repo: `${owner}/${repoName}`, pr: prNumber, reviewer, verdict, duration_ms: Date.now() - ctx.reviewStart })

      spinner.start('posting comment...')
      const octokit = createGithubClient(token)
      await postReviewComment(octokit, owner, repoName, prNumber, commentBody, reviewer)
      const commentUrl = `github.com/${owner}/${repoName}/pull/${prNumber}`
      spinner.succeed(`posted → ${commentUrl}`)
      fileLog({ level: 'info', event: 'comment_posted', repo: `${owner}/${repoName}`, pr: prNumber, url: `https://${commentUrl}` })

      log(formatVerdict(verdict))
      results[step.name] = { verdict, commentBody, commentUrl }

    } else if (step.type === 'address') {
      // Respect post_review.auto_fix config
      const autoFix = config.post_review.auto_fix
      if (!autoFix.enabled || autoFix.trigger === 'never') {
        log(chalk.dim(`  [${step.name}] auto-fix disabled — skipping`))
        results[step.name] = { skipped: true }
        continue
      }

      // Find the most recent review result that has a comment body
      const reviewResult = Object.values(results).reverse().find(r => r.commentBody)
      if (!reviewResult?.commentBody) {
        log(chalk.dim(`  [${step.name}] no review comment available — skipping`))
        results[step.name] = { skipped: true }
        continue
      }

      // min_severity gate: BLOCK=error, NEEDS_WORK=warning, APPROVE=info
      if (autoFix.trigger === 'on_issues') {
        const verdictRank: Record<string, number> = { BLOCK: 2, NEEDS_WORK: 1, APPROVE: 0 }
        const severityRank: Record<string, number> = { error: 2, warning: 1, info: 0 }
        const minRank = severityRank[autoFix.min_severity] ?? 1
        const actualRank = verdictRank[reviewResult.verdict ?? ''] ?? 0
        if (actualRank < minRank) {
          log(chalk.dim(`  [${step.name}] verdict ${reviewResult.verdict} below min_severity ${autoFix.min_severity} — skipping`))
          results[step.name] = { skipped: true }
          continue
        }
      }

      // Derive vendor from autoFix.fixer, not from the workflow step's reviewer field
      let vendor: 'claude' | 'codex' | null
      if (autoFix.fixer === 'same-as-author') {
        vendor = resolveReviewer('origin', origin, config)
      } else if (autoFix.fixer === 'same-as-reviewer') {
        vendor = resolveReviewer('auto', origin, config)
      } else {
        vendor = resolveReviewer(autoFix.fixer, origin, config)
      }

      if (!vendor) {
        log(chalk.dim(`  [${step.name}] fixer vendor not available — skipping`))
        results[step.name] = { skipped: true }
        continue
      }

      // Codex address not yet implemented — skip gracefully
      if (vendor === 'codex') {
        log(chalk.dim(`  [${step.name}] codex address not yet supported — skipping`))
        results[step.name] = { skipped: true }
        continue
      }

      // Guard: don't push more than MAX_CROSSCHECK_COMMITS per PR
      let existingCount = 0
      try {
        const gitLog = execSync('git log --oneline', { cwd: tmpDir, encoding: 'utf8' })
        existingCount = gitLog.split('\n').filter(l => l.includes('[crosscheck]')).length
      } catch { /* ignore */ }

      if (existingCount >= MAX_CROSSCHECK_COMMITS) {
        log(chalk.yellow(`  [${step.name}] ${MAX_CROSSCHECK_COMMITS} [crosscheck] commits already on this PR — stopping`))
        results[step.name] = { skipped: true }
        continue
      }

      spinner.start(`${vendor} addressing review...`)
      let appliedCount = 0
      try {
        ;({ appliedCount } = await runAddressStep(
          tmpDir,
          pr.base.ref,
          pr.title,
          reviewResult.commentBody,
          step.instructions ?? '',
          config,
        ))
      } catch (err) {
        spinner.fail(`address failed: ${err instanceof Error ? err.message : String(err)}`)
        logError({ repo: `${owner}/${repoName}`, pr: prNumber, phase: 'address' }, err)
        results[step.name] = { skipped: true }
        continue
      }

      if (appliedCount === 0) {
        spinner.succeed('nothing to address')
        results[step.name] = { applied_count: 0 }
        continue
      }

      const isFork = pr.head.repo?.full_name !== pr.base.repo.full_name
      const deliveryMode = autoFix.delivery.mode

      if (deliveryMode === 'commit') {
        // Fork PRs: cannot push to contributor's fork
        if (isFork) {
          log(chalk.dim(`  [${step.name}] fork PR — skipping push (cannot push to contributor's fork)`))
          results[step.name] = { skipped: true }
          continue
        }
        execSync('git add -A', { cwd: tmpDir })
        execSync(
          `git commit -m "[crosscheck] address: apply ${appliedCount} fix${appliedCount !== 1 ? 'es' : ''} from code review — by Claude Code"`,
          { cwd: tmpDir },
        )
        const newSha = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim()
        execSync(`git push origin HEAD:${pr.head.ref}`, {
          cwd: tmpDir,
          env: { ...process.env, GITHUB_TOKEN: token, GH_TOKEN: token },
        })
        ctx.crosscheckShas.add(newSha)
        spinner.succeed(`addressed ${appliedCount} issue${appliedCount !== 1 ? 's' : ''} → pushed to ${pr.head.ref}`)
        fileLog({ level: 'info', event: 'address_complete', repo: `${owner}/${repoName}`, pr: prNumber, applied_count: appliedCount, sha: newSha, delivery: 'commit' })
        results[step.name] = { applied_count: appliedCount }

      } else if (deliveryMode === 'pull_request') {
        // Fork PRs: cannot push to contributor's fork
        if (isFork) {
          log(chalk.dim(`  [${step.name}] fork PR — skipping push (cannot push to contributor's fork)`))
          results[step.name] = { skipped: true }
          continue
        }
        // Create a fix branch and open a PR targeting the original branch
        const fixBranch = `fix/cr-${prNumber}-address-issues`
        execSync(`git checkout -b ${fixBranch}`, { cwd: tmpDir })
        execSync('git add -A', { cwd: tmpDir })
        execSync(
          `git commit -m "[crosscheck] fix: address CR issues from review of PR #${prNumber} — by Claude Code"`,
          { cwd: tmpDir },
        )
        const newSha = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim()
        execSync(`git push origin HEAD:${fixBranch}`, {
          cwd: tmpDir,
          env: { ...process.env, GITHUB_TOKEN: token, GH_TOKEN: token },
        })
        ctx.crosscheckShas.add(newSha)

        const octokit = createGithubClient(token)
        const fixPrTitle = autoFix.delivery.pr_title.replace('#{original_pr_title}', pr.title)
        const { data: fixPr } = await octokit.rest.pulls.create({
          owner,
          repo: repoName,
          head: fixBranch,
          base: pr.head.ref,
          title: fixPrTitle,
          body: `Auto-fix by crosscheck for CR issues found in #${prNumber}.\n\nReview: https://github.com/${owner}/${repoName}/pull/${prNumber}`,
        })
        if (autoFix.delivery.label) {
          try {
            await octokit.rest.issues.addLabels({
              owner, repo: repoName, issue_number: fixPr.number, labels: [autoFix.delivery.label],
            })
          } catch { /* label may not exist in this repo — skip */ }
        }
        spinner.succeed(`fix PR #${fixPr.number} opened → ${fixPr.html_url}`)
        fileLog({ level: 'info', event: 'address_complete', repo: `${owner}/${repoName}`, pr: prNumber, applied_count: appliedCount, sha: newSha, delivery: 'pull_request', fix_pr: fixPr.number })
        results[step.name] = { applied_count: appliedCount }

      } else {
        // comment: post the diff as a suggested-fix comment, no code push needed (works for fork PRs too)
        let patch = ''
        try { patch = execSync('git diff', { cwd: tmpDir, encoding: 'utf8' }) } catch { /* ignore */ }
        if (patch) {
          const octokit = createGithubClient(token)
          const body = `### Suggested fixes (crosscheck auto-fix)\n\n\`\`\`diff\n${patch.slice(0, 16000)}\n\`\`\``
          await octokit.rest.issues.createComment({ owner, repo: repoName, issue_number: prNumber, body })
        }
        spinner.succeed(`fix suggestions posted as review comment`)
        fileLog({ level: 'info', event: 'address_complete', repo: `${owner}/${repoName}`, pr: prNumber, applied_count: appliedCount, delivery: 'comment' })
        results[step.name] = { applied_count: appliedCount }
      }
    }
  }
}
