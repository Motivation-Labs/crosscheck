import { execSync } from 'child_process'
import chalk from 'chalk'
import type { Config } from '../config/schema.js'
import type { PREvent } from '../github/webhook.js'
import type { PROrigin } from '../github/detector.js'
import { runCodexReview } from '../reviewers/codex.js'
import { runClaudeReview } from '../reviewers/claude.js'
import { runAddressStep } from '../reviewers/address.js'
import { parseVerdict, prependVerdictToComment } from '../lib/verdict.js'
import { createGithubClient, postReviewComment } from '../github/client.js'
import { log as fileLog, logError } from '../lib/logger.js'
import { loadWorkflow, evaluateWhen, type StepResult } from '../lib/workflow.js'

const MAX_CROSSCHECK_COMMITS = 5

export interface PRPhaseData {
  verdict?: string | null
  commentCount?: number
  fixCount?: number
}

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
  onPhaseChange: (label: string, data?: PRPhaseData) => void
  // SHAs crosscheck pushed — used to skip self-triggered synchronize events
  crosscheckShas: Set<string>
}

export interface WorkflowResult {
  verdict: string | null
}

function countComments(reviewText: string): number {
  const bullets = (reviewText.match(/^[-*•]\s/gm) ?? []).length
  const numbered = (reviewText.match(/^\d+\.\s/gm) ?? []).length
  return bullets + numbered
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

export async function runWorkflow(ctx: WorkflowContext): Promise<WorkflowResult> {
  const { owner, repoName, prNumber, pr, tmpDir, token, config, origin, log, onPhaseChange } = ctx
  const steps = loadWorkflow(process.cwd())
  const results: Record<string, StepResult> = {}

  for (const step of steps) {
    // Evaluate when condition — skip step if false
    if (step.when && !evaluateWhen(step.when, results)) {
      fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repoName}`, pr: prNumber, step: step.name, reason: 'when_condition' })
      results[step.name] = { skipped: true }
      continue
    }

    if (step.type === 'review' || step.type === 'recheck') {
      const reviewer = resolveReviewer(step.reviewer, origin, config)
      if (!reviewer) {
        fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repoName}`, pr: prNumber, step: step.name, reason: 'no_reviewer' })
        results[step.name] = { skipped: true }
        continue
      }

      fileLog({ level: 'info', event: 'review_started', repo: `${owner}/${repoName}`, pr: prNumber, reviewer })

      onPhaseChange(`${reviewer} reviewing...`)
      let rawReview: string
      if (reviewer === 'codex') {
        rawReview = await runCodexReview(tmpDir, pr.base.ref, pr.title, config.quality, config.vendors.codex.model, config.vendors.codex.auth)
      } else {
        rawReview = await runClaudeReview(tmpDir, pr.base.ref, pr.title, config.quality, config.vendors.claude, config.budget.per_review_usd)
      }

      const { verdict, clean } = parseVerdict(rawReview)
      const commentBody = prependVerdictToComment(clean, verdict)
      const commentCount = countComments(rawReview)
      fileLog({ level: 'info', event: 'review_complete', repo: `${owner}/${repoName}`, pr: prNumber, reviewer, verdict, duration_ms: Date.now() - ctx.reviewStart })

      onPhaseChange('posting comment...', { verdict: verdict ?? undefined, commentCount })
      const octokit = createGithubClient(token)
      await postReviewComment(octokit, owner, repoName, prNumber, commentBody, reviewer)
      const commentUrl = `github.com/${owner}/${repoName}/pull/${prNumber}`
      fileLog({ level: 'info', event: 'comment_posted', repo: `${owner}/${repoName}`, pr: prNumber, url: `https://${commentUrl}` })

      results[step.name] = { verdict, commentBody, commentUrl }

    } else if (step.type === 'address') {
      // Respect post_review.auto_fix config
      const autoFix = config.post_review.auto_fix
      if (!autoFix.enabled || autoFix.trigger === 'never') {
        fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repoName}`, pr: prNumber, step: step.name, reason: 'auto_fix_disabled' })
        results[step.name] = { skipped: true }
        continue
      }

      // Find the most recent review result that has a comment body
      const reviewResult = Object.values(results).reverse().find(r => r.commentBody)
      if (!reviewResult?.commentBody) {
        fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repoName}`, pr: prNumber, step: step.name, reason: 'no_review_comment' })
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
          fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repoName}`, pr: prNumber, step: step.name, reason: 'below_min_severity', verdict: reviewResult.verdict })
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
        fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repoName}`, pr: prNumber, step: step.name, reason: 'no_vendor' })
        results[step.name] = { skipped: true }
        continue
      }

      // Codex address not yet implemented — skip gracefully
      if (vendor === 'codex') {
        fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repoName}`, pr: prNumber, step: step.name, reason: 'codex_address_unsupported' })
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
        log(chalk.yellow(`⚠  PR #${prNumber}: ${MAX_CROSSCHECK_COMMITS} [crosscheck] commits already — stopping auto-fix`))
        results[step.name] = { skipped: true }
        continue
      }

      onPhaseChange(`${vendor} addressing...`)
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
        logError({ repo: `${owner}/${repoName}`, pr: prNumber, phase: 'address' }, err)
        results[step.name] = { skipped: true }
        continue
      }

      if (appliedCount === 0) {
        results[step.name] = { applied_count: 0 }
        continue
      }

      const isFork = pr.head.repo?.full_name !== pr.base.repo.full_name
      if (isFork) {
        fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repoName}`, pr: prNumber, step: step.name, reason: 'fork_pr' })
        results[step.name] = { skipped: true }
        continue
      }

      const deliveryMode = autoFix.delivery.mode

      if (deliveryMode === 'commit') {
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
        onPhaseChange('addressed ✓', { fixCount: appliedCount })
        fileLog({ level: 'info', event: 'address_complete', repo: `${owner}/${repoName}`, pr: prNumber, applied_count: appliedCount, sha: newSha, delivery: 'commit' })
        results[step.name] = { applied_count: appliedCount }

      } else if (deliveryMode === 'pull_request') {
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
        onPhaseChange('addressed ✓', { fixCount: appliedCount })
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
        onPhaseChange('addressed ✓', { fixCount: appliedCount })
        fileLog({ level: 'info', event: 'address_complete', repo: `${owner}/${repoName}`, pr: prNumber, applied_count: appliedCount, delivery: 'comment' })
        results[step.name] = { applied_count: appliedCount }
      }
    }
  }

  const verdict = Object.values(results).reverse().find(r => r.verdict !== undefined)?.verdict ?? null
  return { verdict: verdict ?? null }
}
