import { execSync } from 'child_process'
import chalk from 'chalk'
import type { Config } from '../config/schema.js'
import type { PREvent } from '../github/webhook.js'
import type { PROrigin } from '../github/detector.js'
import { runCodexReview } from '../reviewers/codex.js'
import { runClaudeReview } from '../reviewers/claude.js'
import { runFixStep } from '../reviewers/fix.js'
import { parseVerdict, prependVerdictToComment, NULL_VERDICT_WARNING } from '../lib/verdict.js'
import { createGithubClient, postReviewComment } from '../github/client.js'
import { log as fileLog, logError } from '../lib/logger.js'
import { loadWorkflow, evaluateWhen, type StepResult } from '../lib/workflow.js'
import type { PRPhase } from '../lib/board.js'

const MAX_CROSSCHECK_COMMITS = 5

export interface PRPhaseData {
  phase?: PRPhase
  verdict?: string | null
  commentCount?: number
  fixCount?: number
  recheckVerdict?: string | null
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
  // When true, review output is printed but the GitHub comment is not posted
  // and the fix step is skipped. Used by `crosscheck run --dry-run`.
  dryRun?: boolean
  // Override the steps to execute instead of loading from workflow.yml.
  // Used by `crosscheck run --steps` to run only a subset of the pipeline.
  steps?: import('./workflow.js').WorkflowStep[]
  // When smart-switch is active, route to this vendor if the step's configured
  // reviewer resolves to a disabled vendor rather than skipping the step.
  smartSwitchFallback?: 'claude' | 'codex'
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
  fallback?: 'claude' | 'codex',
): 'claude' | 'codex' | null {
  if (reviewer === 'origin') {
    if (origin === 'claude' && config.vendors.claude.enabled) return 'claude'
    if (origin === 'codex' && config.vendors.codex.enabled) return 'codex'
    return fallback && config.vendors[fallback].enabled ? fallback : null
  }
  if (reviewer === 'auto') {
    if (origin === 'claude' && config.vendors.codex.enabled) return 'codex'
    if (origin === 'codex' && config.vendors.claude.enabled) return 'claude'
    if (config.vendors.codex.enabled) return 'codex'
    if (config.vendors.claude.enabled) return 'claude'
    return null
  }
  if (reviewer === 'claude') return config.vendors.claude.enabled ? 'claude' : (fallback && config.vendors[fallback].enabled ? fallback : null)
  if (reviewer === 'codex') return config.vendors.codex.enabled ? 'codex' : (fallback && config.vendors[fallback].enabled ? fallback : null)
  return null
}

export async function runWorkflow(ctx: WorkflowContext): Promise<WorkflowResult> {
  const { owner, repoName, prNumber, pr, tmpDir, token, config, origin, log, onPhaseChange } = ctx
  const steps = ctx.steps ?? loadWorkflow(process.cwd())
  const results: Record<string, StepResult> = {}

  for (const step of steps) {
    // Evaluate when condition — skip step if false
    if (step.when && !evaluateWhen(step.when, results)) {
      fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repoName}`, pr: prNumber, step: step.name, reason: 'when_condition' })
      results[step.name] = { skipped: true }
      if (step.type === 'fix') onPhaseChange('', { phase: 'fixed', fixCount: 0 })
      else if (step.type === 'recheck') onPhaseChange('', { phase: 'rechecked' })
      continue
    }

    if (step.type === 'review' || step.type === 'recheck') {
      const isRecheck = step.type === 'recheck'
      const reviewer = resolveReviewer(step.reviewer, origin, config, ctx.smartSwitchFallback)
      if (!reviewer) {
        fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repoName}`, pr: prNumber, step: step.name, reason: 'no_reviewer' })
        results[step.name] = { skipped: true }
        continue
      }

      fileLog({ level: 'info', event: 'review_started', repo: `${owner}/${repoName}`, pr: prNumber, reviewer })

      const startPhase: PRPhase = isRecheck ? 'rechecking' : 'reviewing'
      const donePhase: PRPhase = isRecheck ? 'rechecked' : 'reviewed'
      onPhaseChange(`${reviewer} ${isRecheck ? 'rechecking' : 'reviewing'}...`, { phase: startPhase })
      let rawReview: string
      if (reviewer === 'codex') {
        rawReview = await runCodexReview(tmpDir, pr.base.ref, pr.title, config.quality, config.vendors.codex, step.instructions)
      } else {
        rawReview = await runClaudeReview(tmpDir, pr.base.ref, pr.title, config.quality, config.vendors.claude, config.budget.per_review_usd, step.instructions)
      }

      const { verdict, clean } = parseVerdict(rawReview)
      if (verdict === null) {
        fileLog({ level: 'warn', event: 'verdict_parse_failed', repo: `${owner}/${repoName}`, pr: prNumber, reviewer, output_length: rawReview.length })
      }
      const commentBody = verdict === null
        ? `${NULL_VERDICT_WARNING}\n\n${clean}`
        : prependVerdictToComment(clean, verdict)
      const commentCount = countComments(rawReview)
      fileLog({ level: 'info', event: 'review_complete', repo: `${owner}/${repoName}`, pr: prNumber, reviewer, verdict, duration_ms: Date.now() - ctx.reviewStart })

      // Recheck verdict is stored separately to preserve the original review's commentCount on the board
      const phaseUpdate: PRPhaseData = isRecheck
        ? { recheckVerdict: verdict, phase: donePhase }
        : { verdict, commentCount, phase: donePhase }

      if (ctx.dryRun) {
        onPhaseChange('dry-run — comment not posted', phaseUpdate)
        log(chalk.dim(`\n--- dry-run: comment that would be posted ---\n${commentBody}\n--- end ---`))
        results[step.name] = { verdict, commentBody }
      } else {
        onPhaseChange(isRecheck ? 'posting recheck...' : 'posting comment...', phaseUpdate)
        const octokit = createGithubClient(token)
        await postReviewComment(octokit, owner, repoName, prNumber, commentBody, reviewer, config.brand)
        const commentUrl = `github.com/${owner}/${repoName}/pull/${prNumber}`
        fileLog({ level: 'info', event: 'comment_posted', repo: `${owner}/${repoName}`, pr: prNumber, url: `https://${commentUrl}` })
        results[step.name] = { verdict, commentBody, commentUrl }
      }

    } else if (step.type === 'fix') {
      const skipFix = (reason: string) => {
        onPhaseChange('', { phase: 'fixed', fixCount: 0 })
        results[step.name] = { skipped: true }
        fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repoName}`, pr: prNumber, step: step.name, reason })
      }

      if (ctx.dryRun) { skipFix('dry_run'); continue }

      // Migration gate: honor legacy opt-out fields while users migrate to workflow.yml.
      const legacyDisabled = config.post_review.auto_fix.enabled === false
        || config.post_review.auto_fix.trigger === 'never'
      if (legacyDisabled) {
        log(chalk.yellow(`⚠  auto_fix.enabled/trigger are deprecated — remove them from config and add a "when:" condition to the fix step in workflow.yml instead`))
        skipFix('legacy_auto_fix_disabled')
        continue
      }

      // Find the most recent review result that has a comment body
      const reviewResult = Object.values(results).reverse().find(r => r.commentBody)
      if (!reviewResult?.commentBody) { skipFix('no_review_comment'); continue }

      // Vendor is resolved from the workflow step's reviewer field, same as review/recheck steps.
      // Use 'origin' to fix with the same vendor that authored the PR (recommended default).
      const vendor = resolveReviewer(step.reviewer, origin, config, ctx.smartSwitchFallback)
      if (!vendor) { skipFix('no_vendor'); continue }

      // Codex fix not yet implemented — skip gracefully
      if (vendor === 'codex') { skipFix('codex_fix_unsupported'); continue }

      // Guard: don't push more than MAX_CROSSCHECK_COMMITS per PR
      let existingCount = 0
      try {
        const gitLog = execSync('git log --oneline', { cwd: tmpDir, encoding: 'utf8' })
        existingCount = gitLog.split('\n').filter(l => l.includes('[crosscheck]')).length
      } catch { /* ignore */ }

      if (existingCount >= MAX_CROSSCHECK_COMMITS) {
        log(chalk.yellow(`⚠  PR #${prNumber}: ${MAX_CROSSCHECK_COMMITS} [crosscheck] commits already — stopping auto-fix`))
        skipFix('commit_limit_reached')
        continue
      }

      onPhaseChange(`${vendor} fixing...`, { phase: 'fixing' })
      let appliedCount = 0
      try {
        ;({ appliedCount } = await runFixStep(
          tmpDir,
          pr.base.ref,
          pr.title,
          reviewResult.commentBody,
          step.instructions ?? '',
          config,
        ))
      } catch (err) {
        logError({ repo: `${owner}/${repoName}`, pr: prNumber, phase: 'fix' }, err)
        skipFix('fix_error')
        continue
      }

      if (appliedCount === 0) {
        onPhaseChange('', { phase: 'fixed', fixCount: 0 })
        results[step.name] = { applied_count: 0 }
        continue
      }

      const isFork = pr.head.repo?.full_name !== pr.base.repo.full_name
      if (isFork) { skipFix('fork_pr'); continue }

      const deliveryMode = config.post_review.auto_fix.delivery.mode

      if (deliveryMode === 'commit') {
        execSync('git add -A', { cwd: tmpDir })
        execSync(
          `git commit -m "[crosscheck] fix: apply ${appliedCount} fix${appliedCount !== 1 ? 'es' : ''} from code review — by Claude Code"`,
          { cwd: tmpDir },
        )
        const newSha = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim()
        execSync(`git push origin HEAD:${pr.head.ref}`, {
          cwd: tmpDir,
          env: { ...process.env, GITHUB_TOKEN: token, GH_TOKEN: token },
        })
        ctx.crosscheckShas.add(newSha)
        onPhaseChange('fixed ✓', { fixCount: appliedCount, phase: 'fixed' })
        fileLog({ level: 'info', event: 'fix_complete', repo: `${owner}/${repoName}`, pr: prNumber, applied_count: appliedCount, sha: newSha, delivery: 'commit' })
        results[step.name] = { applied_count: appliedCount }

      } else if (deliveryMode === 'pull_request') {
        // Create a fix branch and open a PR targeting the original branch
        const fixBranch = `fix/cr-${prNumber}-review-issues`
        execSync(`git checkout -b ${fixBranch}`, { cwd: tmpDir })
        execSync('git add -A', { cwd: tmpDir })
        execSync(
          `git commit -m "[crosscheck] fix: apply CR fixes from review of PR #${prNumber} — by Claude Code"`,
          { cwd: tmpDir },
        )
        const newSha = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim()
        execSync(`git push origin HEAD:${fixBranch}`, {
          cwd: tmpDir,
          env: { ...process.env, GITHUB_TOKEN: token, GH_TOKEN: token },
        })
        ctx.crosscheckShas.add(newSha)

        const octokit = createGithubClient(token)
        const fixPrTitle = config.post_review.auto_fix.delivery.pr_title.replace('#{original_pr_title}', pr.title)
        const { data: fixPr } = await octokit.rest.pulls.create({
          owner,
          repo: repoName,
          head: fixBranch,
          base: pr.head.ref,
          title: fixPrTitle,
          body: `Auto-fix by crosscheck for CR issues found in #${prNumber}.\n\nReview: https://github.com/${owner}/${repoName}/pull/${prNumber}`,
        })
        if (config.post_review.auto_fix.delivery.label) {
          try {
            await octokit.rest.issues.addLabels({
              owner, repo: repoName, issue_number: fixPr.number, labels: [config.post_review.auto_fix.delivery.label],
            })
          } catch { /* label may not exist in this repo — skip */ }
        }
        onPhaseChange('fixed ✓', { fixCount: appliedCount, phase: 'fixed' })
        fileLog({ level: 'info', event: 'fix_complete', repo: `${owner}/${repoName}`, pr: prNumber, applied_count: appliedCount, sha: newSha, delivery: 'pull_request', fix_pr: fixPr.number })
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
        onPhaseChange('fixed ✓', { fixCount: appliedCount, phase: 'fixed' })
        fileLog({ level: 'info', event: 'fix_complete', repo: `${owner}/${repoName}`, pr: prNumber, applied_count: appliedCount, delivery: 'comment' })
        results[step.name] = { applied_count: appliedCount }
      }
    }
  }

  const verdict = Object.values(results).reverse().find(r => r.verdict !== undefined)?.verdict ?? null
  return { verdict: verdict ?? null }
}
