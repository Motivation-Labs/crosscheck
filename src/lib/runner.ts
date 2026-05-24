import { execSync, execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import chalk from 'chalk'
import type { Config } from '../config/schema.js'
import type { PREvent } from '../github/webhook.js'
import type { PROrigin } from '../github/detector.js'
import { runCodexReview } from '../reviewers/codex.js'
import { runClaudeReview } from '../reviewers/claude.js'
import { runFixStep } from '../reviewers/fix.js'
import { runConflictResolveStep, findConflictedFiles } from '../reviewers/conflict-resolve.js'
import { parseVerdict, prependVerdictToComment, NULL_VERDICT_WARNING } from '../lib/verdict.js'
import { createGithubClient, postReviewComment, getLastCrossCheckCommentId } from '../github/client.js'
import { acquireRemoteLock, releaseRemoteLock } from '../github/review-status.js'
import { log as fileLog, logError } from '../lib/logger.js'
import { loadWorkflow, evaluateWhen, type StepResult } from '../lib/workflow.js'
import type { PRPhase } from '../lib/board.js'

const MAX_CROSSCHECK_COMMITS = 5
const FIX_RETRY_DELAY_MS = 2 * 60 * 1000

// Auth failures are operator issues that won't self-heal — everything else is worth a retry.
export function isRetryableFixError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return !/auth failure|not logged in|claude auth/i.test(msg)
}

// When a PR has already been reviewed, subsequent webhook runs treat every
// 'review' step as a 'recheck' so the first review's CR result is preserved.
export function getEffectiveStepType(stepType: string, isRecheckRun: boolean): string {
  return stepType === 'review' && isRecheckRun ? 'recheck' : stepType
}

// Counts crosscheck-authored commits unique to this PR (ahead of base) rather
// than the branch's full history. Long-lived integration branches like
// `staging` accumulate [crosscheck] commits from many merged PRs — counting
// those would trip the per-PR fix-loop guard immediately and skip fix/recheck.
//
// Fails closed: when `origin/<base>` isn't available (e.g. clone fetched the
// base ref with `base_branch_fetch_skipped`), fall back to the full-history
// count rather than returning 0. Over-counting can stop fix early; returning 0
// would silently disable the cap and let runaway fix loops keep pushing.
export function countCrosscheckCommitsForPR(tmpDir: string, baseRef: string): number {
  const runLog = (args: string[]): string =>
    execFileSync(
      'git',
      ['log', '--oneline', ...args],
      { cwd: tmpDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
  const count = (out: string): number => out.split('\n').filter(l => l.includes('[crosscheck]')).length

  try {
    return count(runLog([`origin/${baseRef}..HEAD`]))
  } catch {
    // Scoped range unavailable — fall back to full history so the cap still
    // applies. May over-count when the branch has prior merged crosscheck
    // commits, but that's preferable to bypassing the safety guard.
    try {
      return count(runLog([]))
    } catch {
      return 0
    }
  }
}

// Returns true when fix/recheck steps should be skipped because the configured
// max_rounds cap has been reached. The review step (even when coerced to recheck)
// is never skipped — it always produces a verdict for the current push.
export function exceedsMaxRounds(
  effectiveType: string,
  originalStepType: string,
  maxRounds: number,
  round: number | undefined,
): boolean {
  if (round === undefined) return false
  if (effectiveType === 'fix') return round > maxRounds
  if (effectiveType === 'conflict-resolve') return round > maxRounds
  // Recheck step from the workflow (not a review coerced to recheck) is gated
  if (effectiveType === 'recheck' && originalStepType !== 'review') return round > maxRounds
  return false
}

export interface PRPhaseData {
  phase?: PRPhase
  verdict?: string | null
  commentCount?: number
  fixCount?: number
  recheckVerdict?: string | null
  crTokens?: number
  recheckTokens?: number
  fixTokens?: number
  crReviewer?: string
  recheckReviewer?: string
  qualityTier?: string
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
  // When true, all 'review' steps are coerced to 'recheck' steps — preserving
  // the first round's CR result on the board while still posting a verdict.
  isRecheckRun?: boolean
  // 1-based round counter passed to log events and the board display.
  round?: number
  // When true, review output is printed but the GitHub comment is not posted
  // and the fix step is skipped. Used by `crosscheck run --dry-run`.
  dryRun?: boolean
  // Override the steps to execute instead of loading from workflow.yml.
  // Used by `crosscheck run --steps` to run only a subset of the pipeline.
  steps?: import('./workflow.js').WorkflowStep[]
  // When smart-switch is active, route to this vendor if the step's configured
  // reviewer resolves to a disabled vendor rather than skipping the step.
  smartSwitchFallback?: 'claude' | 'codex'
  // Caller-supplied array the runner appends to whenever it sets a remote
  // pending status on a newly pushed sha (currently only from conflict-resolve).
  // Lets the command-layer signal handler release those shas if SIGINT/SIGTERM
  // fires mid-workflow — otherwise process.exit bypasses the runner's finally
  // and the pending status is leaked indefinitely on GitHub.
  pushedShas?: string[]
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
  // SHAs the workflow pushed AND set a `crosscheck/review` pending status on.
  // Each one must be released in the finally below — otherwise the pending
  // status would stay forever on GitHub (the 15-min staleness check is
  // internal to crosscheck's lock detection and does not clear the status,
  // which can block PRs in repos where `crosscheck/review` is required).
  //
  // Use the caller's array if provided so the command-layer signal handler
  // can iterate the same list and release these shas if SIGINT/SIGTERM fires
  // mid-workflow (process.exit there bypasses our finally below).
  const pushedShasNeedingRelease: string[] = ctx.pushedShas ?? []
  let workflowFailed = false

  try {
  for (const step of steps) {
    const effectiveType = getEffectiveStepType(step.type, ctx.isRecheckRun === true)

    if (exceedsMaxRounds(effectiveType, step.type, step.max_rounds, ctx.round)) {
      fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repoName}`, pr: prNumber, step: step.name, reason: 'max_rounds' })
      results[step.name] = { skipped: true }
      if (effectiveType === 'fix') onPhaseChange('', { phase: 'fixed', fixCount: 0 })
      else if (effectiveType === 'recheck') onPhaseChange('', { phase: 'rechecked' })
      else if (effectiveType === 'conflict-resolve') onPhaseChange('', { phase: 'fixed', fixCount: 0 })
      continue
    }

    // Evaluate when condition — skip step if false
    if (step.when && !evaluateWhen(step.when, results)) {
      fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repoName}`, pr: prNumber, step: step.name, reason: 'when_condition' })
      results[step.name] = { skipped: true }
      if (effectiveType === 'fix') onPhaseChange('', { phase: 'fixed', fixCount: 0 })
      else if (effectiveType === 'recheck') onPhaseChange('', { phase: 'rechecked' })
      else if (effectiveType === 'conflict-resolve') onPhaseChange('', { phase: 'fixed', fixCount: 0 })
      continue
    }

    if (effectiveType === 'review' || effectiveType === 'recheck') {
      const isRecheck = effectiveType === 'recheck'
      const reviewer = resolveReviewer(step.reviewer, origin, config, ctx.smartSwitchFallback)
      if (!reviewer) {
        fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repoName}`, pr: prNumber, step: step.name, reason: 'no_reviewer' })
        results[step.name] = { skipped: true }
        continue
      }

      fileLog({ level: 'info', event: 'review_started', repo: `${owner}/${repoName}`, pr: prNumber, reviewer, ...(ctx.round !== undefined && { round: ctx.round }) })

      const startPhase: PRPhase = isRecheck ? 'rechecking' : 'reviewing'
      const donePhase: PRPhase = isRecheck ? 'rechecked' : 'reviewed'
      onPhaseChange(`${reviewer} ${isRecheck ? 'rechecking' : 'reviewing'}...`, { phase: startPhase })
      let rawReview: string
      let tokensUsed: number | undefined
      if (reviewer === 'codex') {
        ;({ review: rawReview, tokensUsed } = await runCodexReview(tmpDir, pr.base.ref, pr.title, config.quality, config.vendors.codex, step.instructions))
      } else {
        ;({ review: rawReview, tokensUsed } = await runClaudeReview(tmpDir, pr.base.ref, pr.title, config.quality, config.vendors.claude, config.budget.per_review_usd, step.instructions))
      }

      const { verdict, clean } = parseVerdict(rawReview)
      if (verdict === null) {
        fileLog({ level: 'warn', event: 'verdict_parse_failed', repo: `${owner}/${repoName}`, pr: prNumber, reviewer, output_length: rawReview.length })
      }
      const commentBody = verdict === null
        ? `${NULL_VERDICT_WARNING}\n\n${clean}`
        : prependVerdictToComment(clean, verdict)
      const commentCount = countComments(rawReview)
      fileLog({ level: 'info', event: 'review_complete', repo: `${owner}/${repoName}`, pr: prNumber, reviewer, verdict, duration_ms: Date.now() - ctx.reviewStart, tokens_used: tokensUsed, ...(ctx.round !== undefined && { round: ctx.round }) })

      // Recheck verdict is stored separately to preserve the original review's commentCount on the board
      const phaseUpdate: PRPhaseData = isRecheck
        ? { recheckVerdict: verdict, phase: donePhase, recheckTokens: tokensUsed, recheckReviewer: reviewer, qualityTier: config.quality.tier }
        : { verdict, commentCount, phase: donePhase, crTokens: tokensUsed, crReviewer: reviewer, qualityTier: config.quality.tier }

      if (ctx.dryRun) {
        onPhaseChange('dry-run — comment not posted', phaseUpdate)
        log(chalk.dim(`\n--- dry-run: comment that would be posted ---\n${commentBody}\n--- end ---`))
        results[step.name] = { verdict, commentBody }
      } else {
        onPhaseChange(isRecheck ? 'posting recheck...' : 'posting comment...', phaseUpdate)
        const octokit = createGithubClient(token)
        // For rechecks: look up the original review comment ID so the recheck
        // can link back to it. Check in-run results first (single-run pipelines),
        // then fall back to GitHub (cross-run: recheck triggered by a new push).
        let priorReviewId: number | undefined
        if (isRecheck) {
          priorReviewId = Object.values(results).reverse().find(r => r.commentId !== undefined)?.commentId
          if (priorReviewId === undefined) {
            priorReviewId = await getLastCrossCheckCommentId(owner, repoName, prNumber, token)
          }
        }
        const commentId = await postReviewComment(
          octokit, owner, repoName, prNumber, commentBody, reviewer, config.brand,
          origin, verdict ?? undefined, priorReviewId, isRecheck,
        )
        const commentUrl = `github.com/${owner}/${repoName}/pull/${prNumber}`
        fileLog({ level: 'info', event: 'comment_posted', repo: `${owner}/${repoName}`, pr: prNumber, url: `https://${commentUrl}` })
        results[step.name] = { verdict, commentBody, commentUrl, commentId }
      }

    } else if (effectiveType === 'fix') {
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

      // Guard: don't push more than MAX_CROSSCHECK_COMMITS per PR.
      // Scope to commits ahead of base so long-lived branches (e.g. staging)
      // don't count [crosscheck] commits from previously merged PRs.
      const existingCount = countCrosscheckCommitsForPR(tmpDir, pr.base.ref)

      if (existingCount >= MAX_CROSSCHECK_COMMITS) {
        log(chalk.yellow(`⚠  PR #${prNumber}: ${MAX_CROSSCHECK_COMMITS} [crosscheck] commits already — stopping auto-fix`))
        skipFix('commit_limit_reached')
        continue
      }

      onPhaseChange(`${vendor} fixing...`, { phase: 'fixing' })
      let appliedCount = 0
      let fixTokensUsed: number | undefined
      let fixErr: unknown = undefined

      try {
        ;({ appliedCount, tokensUsed: fixTokensUsed } = await runFixStep(
          tmpDir, pr.base.ref, pr.title, reviewResult.commentBody, step.instructions ?? '', config,
        ))
      } catch (err) {
        logError({ repo: `${owner}/${repoName}`, pr: prNumber, phase: 'fix', attempt: 1 }, err)
        fixErr = err
      }

      if (fixErr !== undefined && isRetryableFixError(fixErr)) {
        log(chalk.yellow(`⚠  fix step failed — retrying in 2 min...`))
        onPhaseChange('fix retry in 2 min...', { phase: 'fixing' })
        fileLog({ level: 'info', event: 'fix_retry_scheduled', repo: `${owner}/${repoName}`, pr: prNumber })
        await new Promise<void>(resolve => setTimeout(resolve, FIX_RETRY_DELAY_MS))
        onPhaseChange(`${vendor} fixing (retry)...`, { phase: 'fixing' })
        try {
          ;({ appliedCount, tokensUsed: fixTokensUsed } = await runFixStep(
            tmpDir, pr.base.ref, pr.title, reviewResult.commentBody, step.instructions ?? '', config,
          ))
          fileLog({ level: 'info', event: 'fix_retry_succeeded', repo: `${owner}/${repoName}`, pr: prNumber })
          fixErr = undefined
        } catch (retryErr) {
          logError({ repo: `${owner}/${repoName}`, pr: prNumber, phase: 'fix', attempt: 2 }, retryErr)
          fixErr = retryErr
        }
      }

      if (fixErr !== undefined) {
        skipFix('fix_error')
        // Only notify for transient failures — auth errors are operator issues, not PR author issues
        if (isRetryableFixError(fixErr)) {
          try {
            const octokit = createGithubClient(token)
            await octokit.rest.issues.createComment({
              owner, repo: repoName, issue_number: prNumber,
              body: `⚠️ **Auto-fix failed**\n\nThe fix step timed out after retrying. Push a new commit or run \`crosscheck run ${pr.html_url}\` to retry manually.\n\n<!-- crosscheck: fix_failed -->`,
            })
            fileLog({ level: 'info', event: 'fix_failed_comment_posted', repo: `${owner}/${repoName}`, pr: prNumber })
          } catch { /* best-effort notification */ }
        }
        continue
      }

      if (appliedCount === 0) {
        onPhaseChange('', { phase: 'fixed', fixCount: 0, fixTokens: fixTokensUsed })
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
        onPhaseChange('fixed ✓', { fixCount: appliedCount, phase: 'fixed', fixTokens: fixTokensUsed })
        fileLog({ level: 'info', event: 'fix_complete', repo: `${owner}/${repoName}`, pr: prNumber, applied_count: appliedCount, sha: newSha, delivery: 'commit', tokens_used: fixTokensUsed })
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
        onPhaseChange('fixed ✓', { fixCount: appliedCount, phase: 'fixed', fixTokens: fixTokensUsed })
        fileLog({ level: 'info', event: 'fix_complete', repo: `${owner}/${repoName}`, pr: prNumber, applied_count: appliedCount, sha: newSha, delivery: 'pull_request', fix_pr: fixPr.number, tokens_used: fixTokensUsed })
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
        onPhaseChange('fixed ✓', { fixCount: appliedCount, phase: 'fixed', fixTokens: fixTokensUsed })
        fileLog({ level: 'info', event: 'fix_complete', repo: `${owner}/${repoName}`, pr: prNumber, applied_count: appliedCount, delivery: 'comment', tokens_used: fixTokensUsed })
        results[step.name] = { applied_count: appliedCount }
      }

    } else if (effectiveType === 'conflict-resolve') {
      const skipConflictResolve = (reason: string) => {
        onPhaseChange('', { phase: 'fixed', fixCount: 0 })
        results[step.name] = { skipped: true }
        fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repoName}`, pr: prNumber, step: step.name, reason })
      }

      if (ctx.dryRun) { skipConflictResolve('dry_run'); continue }

      // Fast pre-check: GitHub's mergeable field tells us if the PR has conflicts without
      // cloning. true = no conflicts (skip immediately); false = conflicts confirmed (proceed);
      // null = GitHub is still computing — fall through to the git merge probe.
      {
        const octokit = createGithubClient(token)
        const { data: prInfo } = await octokit.rest.pulls.get({ owner, repo: repoName, pull_number: prNumber })
        if (prInfo.mergeable === true) {
          skipConflictResolve('no_conflicts')
          continue
        }
      }

      // P1: The clone only has the PR head checked out — no unmerged index entries exist
      // until we actually attempt the merge. Attempt the merge first; if it succeeds
      // cleanly (no conflicts) abort it and skip. If it fails, the working tree now has
      // real conflict markers and UU entries that findConflictedFiles can detect.
      let hasMergeConflicts = false
      try {
        execSync(`git merge --no-commit origin/${pr.base.ref}`, { cwd: tmpDir, stdio: 'pipe' })
        // Clean merge — undo the staged merge state and skip this step
        try { execSync('git merge --abort', { cwd: tmpDir }) } catch { /* ignore */ }
      } catch {
        hasMergeConflicts = true
      }

      if (!hasMergeConflicts) {
        skipConflictResolve('no_conflicts')
        continue
      }

      const conflictedFiles = findConflictedFiles(tmpDir)
      if (conflictedFiles.length === 0) {
        try { execSync('git merge --abort', { cwd: tmpDir }) } catch { /* ignore */ }
        skipConflictResolve('no_conflicts')
        continue
      }

      const vendor = resolveReviewer(step.reviewer, origin, config, ctx.smartSwitchFallback)
      if (!vendor) { try { execSync('git merge --abort', { cwd: tmpDir }) } catch { /* ignore */ }; skipConflictResolve('no_vendor'); continue }
      if (vendor === 'codex') { try { execSync('git merge --abort', { cwd: tmpDir }) } catch { /* ignore */ }; skipConflictResolve('codex_conflict_resolve_unsupported'); continue }

      const isFork = pr.head.repo?.full_name !== pr.base.repo.full_name
      if (isFork) { try { execSync('git merge --abort', { cwd: tmpDir }) } catch { /* ignore */ }; skipConflictResolve('fork_pr'); continue }

      const existingCount = countCrosscheckCommitsForPR(tmpDir, pr.base.ref)
      if (existingCount >= MAX_CROSSCHECK_COMMITS) {
        try { execSync('git merge --abort', { cwd: tmpDir }) } catch { /* ignore */ }
        log(chalk.yellow(`⚠  PR #${prNumber}: ${MAX_CROSSCHECK_COMMITS} [crosscheck] commits already — stopping conflict-resolve`))
        skipConflictResolve('commit_limit_reached')
        continue
      }

      onPhaseChange(`${vendor} resolving conflicts...`, { phase: 'fixing' })
      let appliedCount = 0
      let resolvedPaths: string[] = []
      let resolveTokensUsed: number | undefined

      try {
        ;({ appliedCount, resolvedPaths, tokensUsed: resolveTokensUsed } = await runConflictResolveStep(
          tmpDir, pr.title, step.instructions ?? '',
        ))
      } catch (err) {
        logError({ repo: `${owner}/${repoName}`, pr: prNumber, phase: 'conflict-resolve', attempt: 1 }, err)
        try { execSync('git merge --abort', { cwd: tmpDir }) } catch { /* ignore */ }
        skipConflictResolve('resolve_error')
        continue
      }

      if (appliedCount === 0) {
        try { execSync('git merge --abort', { cwd: tmpDir }) } catch { /* ignore */ }
        onPhaseChange('', { phase: 'fixed', fixCount: 0, fixTokens: resolveTokensUsed })
        results[step.name] = { applied_count: 0 }
        continue
      }

      // P2: Verify every conflict region was resolved before committing. Scope the
      // check to the union of (originally-conflicted files) ∪ (files the resolver
      // actually rewrote) — a repo-wide grep would false-positive on legitimate
      // "=======" lines in docs (e.g. Markdown setext headings) and abort valid
      // resolutions, but we still need to cover any path the resolver touched in
      // case it ever edits outside the original conflict set. Read working-tree
      // content directly so untrusted PR-controlled paths never reach a shell.
      const MARKER_RE = /^(<<<<<<<|=======|>>>>>>>)( |$)/m
      const pathsToScan = Array.from(new Set([...conflictedFiles, ...resolvedPaths]))
      const filesWithMarkers: string[] = []
      for (const f of pathsToScan) {
        try {
          const content = readFileSync(join(tmpDir, f), 'utf8')
          if (MARKER_RE.test(content)) filesWithMarkers.push(f)
        } catch { /* unreadable (deleted side of modify/delete) — caught by U-filter below */ }
      }
      if (filesWithMarkers.length > 0) {
        try { execSync('git merge --abort', { cwd: tmpDir }) } catch { /* ignore */ }
        log(chalk.yellow(`⚠  PR #${prNumber}: ${filesWithMarkers.length} file(s) still contain conflict markers — skipping commit`))
        fileLog({ level: 'warn', event: 'conflict_resolve_incomplete', repo: `${owner}/${repoName}`, pr: prNumber, paths: filesWithMarkers })
        skipConflictResolve('incomplete_resolution')
        continue
      }

      // Stage only files the resolver actually rewrote — `git add -A` would
      // otherwise silently stage non-text conflicts (binary, modify/delete) using
      // the worktree side as an un-reviewed resolution. Staging also has to come
      // BEFORE the unmerged-path check below: git keeps a path in the unmerged
      // index until it is explicitly added, so checking earlier would always fail
      // on the resolved files themselves. Use execFileSync (no shell) because
      // resolvedPaths is derived from model output and PR-controlled filenames.
      for (const p of resolvedPaths) {
        try {
          execFileSync('git', ['add', '--', p], { cwd: tmpDir, stdio: 'pipe' })
        } catch { /* skip */ }
      }

      // After staging the resolved files, anything still in U state is a conflict
      // the resolver did not handle (binary, modify/delete, or a failed edit).
      // Abort rather than commit a partial merge.
      let unmergedPaths: string[] = []
      try {
        const out = execSync('git diff --name-only --diff-filter=U', { cwd: tmpDir, encoding: 'utf8' })
        unmergedPaths = out.trim().split('\n').filter(Boolean)
      } catch { /* ignore */ }
      if (unmergedPaths.length > 0) {
        try { execSync('git merge --abort', { cwd: tmpDir }) } catch { /* ignore */ }
        log(chalk.yellow(`⚠  PR #${prNumber}: ${unmergedPaths.length} unmerged path(s) remain after resolve — skipping commit`))
        fileLog({ level: 'warn', event: 'conflict_resolve_unmerged_paths', repo: `${owner}/${repoName}`, pr: prNumber, paths: unmergedPaths })
        skipConflictResolve('unmerged_paths')
        continue
      }

      execSync(
        `git commit -m "[crosscheck] resolve: resolve ${conflictedFiles.length} conflict${conflictedFiles.length !== 1 ? 's' : ''} — by Claude Code"`,
        { cwd: tmpDir },
      )
      const newSha = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim()
      execSync(`git push origin HEAD:${pr.head.ref}`, {
        cwd: tmpDir,
        env: { ...process.env, GITHUB_TOKEN: token, GH_TOKEN: token },
      })
      ctx.crosscheckShas.add(newSha)
      // Move the in-flight pending status to newSha so watchers on other
      // machines (which don't share crosscheckShas) see the PR as locked when
      // they receive the synchronize event and skip duplicate review.
      // Track the sha so the finally below releases the pending status —
      // without that release the status would stay pending forever on GitHub.
      try {
        const lockOctokit = createGithubClient(token)
        await acquireRemoteLock(lockOctokit, owner, repoName, newSha)
        pushedShasNeedingRelease.push(newSha)
      } catch (err) {
        fileLog({ level: 'warn', event: 'remote_lock_refresh_failed', repo: `${owner}/${repoName}`, pr: prNumber, sha: newSha, error: err instanceof Error ? err.message : String(err) })
      }
      onPhaseChange('conflicts resolved ✓', { fixCount: appliedCount, phase: 'fixed', fixTokens: resolveTokensUsed })
      fileLog({ level: 'info', event: 'conflict_resolve_complete', repo: `${owner}/${repoName}`, pr: prNumber, conflicts_resolved: conflictedFiles.length, sha: newSha, tokens_used: resolveTokensUsed })
      results[step.name] = { applied_count: appliedCount }
    }
  }

  const verdict = Object.values(results).reverse().find(r => r.verdict !== undefined)?.verdict ?? null
  return { verdict: verdict ?? null }
  } catch (err) {
    workflowFailed = true
    throw err
  } finally {
    if (pushedShasNeedingRelease.length > 0) {
      const lockOctokit = createGithubClient(token)
      const outcome: 'success' | 'failure' = workflowFailed ? 'failure' : 'success'
      // Drain via shift() so each released sha is synchronously removed from
      // the shared array. The command-layer SIGINT/SIGTERM handler iterates
      // the same array — if a late signal arrives after this finally has
      // already released a sha, the handler won't see it and won't overwrite
      // the released status with 'failure'. Atomic shift gives clean per-sha
      // ownership transfer even when both loops are draining concurrently.
      while (pushedShasNeedingRelease.length > 0) {
        const s = pushedShasNeedingRelease.shift()!
        try {
          await releaseRemoteLock(lockOctokit, owner, repoName, s, outcome)
        } catch (err) {
          fileLog({ level: 'warn', event: 'pushed_sha_release_failed', repo: `${owner}/${repoName}`, pr: prNumber, sha: s, error: err instanceof Error ? err.message : String(err) })
        }
      }
    }
  }
}
