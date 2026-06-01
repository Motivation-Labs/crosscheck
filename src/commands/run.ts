import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import chalk from 'chalk'
import { parseDuration } from '../lib/durations.js'
import ora from 'ora'
import { createGithubClient } from '../github/client.js'
import { detectOriginFull, assignReviewer } from '../github/detector.js'
import { loadConfig, getGithubToken } from '../config/loader.js'
import { normalizeVendor, VENDOR_ALIAS_HINT } from '../lib/vendor.js'
import { initLogger, log as fileLog, logError } from '../lib/logger.js'
import { runWorkflow } from '../lib/runner.js'
import { DEFAULT_RECHECK_INSTRUCTIONS, loadWorkflow, type WorkflowStep } from '../lib/workflow.js'
import { formatVerdict, type Verdict } from '../lib/verdict.js'
import { clonePRForReview } from '../lib/clone.js'
import { acquirePRLock, releasePRLock } from '../lib/pr-lock.js'
import { checkRemoteLock, acquireRemoteLock, releaseRemoteLock, startRemoteLockHeartbeat } from '../github/review-status.js'
import type { PREvent } from '../github/webhook.js'

export interface RunOpts {
  config?: string
  reviewer?: string
  steps?: string
  dryRun?: boolean
  roundMode?: 'crazy' | 'halfcrazy'
  initialReviewComment?: {
    id?: number
    body: string
  }
  expectedHeadSha?: string
  timeout?: string
  noTimeout?: boolean
}

const CRAZY_ROUND_CEILING = 2

function meetsCrazyStopCondition(verdict: string | null, mode: 'crazy' | 'halfcrazy'): boolean {
  if (verdict === null) return false
  if (mode === 'crazy') return verdict === 'APPROVE'
  // halfcrazy: any non-BLOCK verdict (APPROVE or NEEDS_WORK) is acceptable
  return verdict !== 'BLOCK'
}

function parsePRUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (!m) return null
  return { owner: m[1], repo: m[2], number: parseInt(m[3], 10) }
}

function pinReviewers(steps: WorkflowStep[], assignedReviewer: 'claude' | 'codex'): WorkflowStep[] {
  return steps.map(s =>
    s.type === 'review' || s.type === 'recheck' ? { ...s, reviewer: assignedReviewer } : s,
  )
}

function synthesizeRecheckStep(allSteps: WorkflowStep[], assignedReviewer: 'claude' | 'codex'): WorkflowStep | null {
  const reviewStep = allSteps.find(s => s.type === 'review')
  if (!reviewStep) return null
  return {
    ...reviewStep,
    name: 'recheck',
    type: 'recheck',
    reviewer: assignedReviewer,
    when: undefined,
    max_rounds: reviewStep.max_rounds,
    instructions: DEFAULT_RECHECK_INSTRUCTIONS,
  }
}

function appendAfterLastFix(steps: WorkflowStep[], step: WorkflowStep): WorkflowStep[] {
  const lastFix = steps.map(s => s.type).lastIndexOf('fix')
  if (lastFix === -1) return [...steps, step]
  return [...steps.slice(0, lastFix + 1), step, ...steps.slice(lastFix + 1)]
}

export function resolveWorkflowSteps(
  allSteps: WorkflowStep[],
  stepFilter: string[] | undefined,
  assignedReviewer: 'claude' | 'codex',
): WorkflowStep[] {
  const selected = stepFilter
    ? allSteps.filter(s => stepFilter.includes(s.type) || stepFilter.includes(s.name))
    : allSteps
  let steps = pinReviewers(selected, assignedReviewer)

  if (stepFilter?.includes('recheck') && !steps.some(s => s.type === 'recheck')) {
    const synthetic = synthesizeRecheckStep(allSteps, assignedReviewer)
    if (synthetic) steps = appendAfterLastFix(steps, synthetic)
  }

  return steps
}

export function buildFixRecheckSteps(
  steps: WorkflowStep[],
  allSteps: WorkflowStep[],
  assignedReviewer: 'claude' | 'codex',
): WorkflowStep[] {
  const selectedFixRecheckSteps = steps.filter(s => s.type === 'fix' || s.type === 'recheck')
  const sourceSteps = selectedFixRecheckSteps.length > 0
    ? selectedFixRecheckSteps
    : pinReviewers(allSteps.filter(s => s.type === 'fix' || s.type === 'recheck'), assignedReviewer)
  let fixRecheckSteps = [...sourceSteps]
  if (!fixRecheckSteps.some(s => s.type === 'fix')) {
    const fixStep = allSteps.find(s => s.type === 'fix')
    if (fixStep) fixRecheckSteps = [fixStep, ...fixRecheckSteps]
  }
  if (!fixRecheckSteps.some(s => s.type === 'recheck')) {
    const synthetic = synthesizeRecheckStep(allSteps, assignedReviewer)
    if (synthetic) fixRecheckSteps = appendAfterLastFix(fixRecheckSteps, synthetic)
  }
  return fixRecheckSteps
}

export async function runRun(prUrl: string, opts: RunOpts = {}) {
  if (opts.roundMode && opts.dryRun) {
    console.error(chalk.red(`✗ --${opts.roundMode} and --dry-run are mutually exclusive`))
    process.exit(1)
  }

  // crazy/halfcrazy (or --no-timeout) lift all constraints including the reviewer timeout (0 = no cap).
  // Otherwise parse the user-supplied --timeout value; undefined keeps each reviewer's default.
  let reviewerTimeoutMs: number | undefined
  if (opts.roundMode || opts.noTimeout) {
    reviewerTimeoutMs = 0
  } else if (opts.timeout) {
    try {
      reviewerTimeoutMs = parseDuration(opts.timeout)
    } catch {
      console.error(chalk.red(`✗ Invalid --timeout value "${opts.timeout}". Use a duration like 300s or 10m.`))
      process.exit(1)
    }
  }

  const config = loadConfig(opts.config)
  initLogger(config.logs)
  fileLog({ level: 'info', event: 'session_start', command: 'run', pr_url: prUrl, ...(opts.roundMode && { round_mode: opts.roundMode }) })

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
  if (opts.expectedHeadSha !== undefined && prData.head.sha !== opts.expectedHeadSha) {
    spinner.warn(`PR #${number} head changed since selection — skipping stale_signature`)
    fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repo}`, pr: number, reason: 'stale_signature', expected_sha: opts.expectedHeadSha, actual_sha: prData.head.sha })
    return
  }
  spinner.succeed(`PR #${number}: ${prData.title}`)
  fileLog({ level: 'info', event: 'pr_received', repo: `${owner}/${repo}`, pr: number, sha: prData.head.sha })

  // Resolve origin and reviewer
  const normalizedReviewer = normalizeVendor(opts.reviewer)
  if (opts.reviewer !== undefined && normalizedReviewer === null) {
    console.error(chalk.red(`✗ Unknown reviewer "${opts.reviewer}". Expected: ${VENDOR_ALIAS_HINT}`))
    process.exit(1)
  }

  let origin: import('../github/detector.js').PROrigin
  if (normalizedReviewer !== null) {
    // --reviewer forces the origin to the opposite vendor (cross-vendor semantics)
    origin = normalizedReviewer === 'codex' ? 'claude' : 'codex'
    console.log(chalk.dim(`  reviewer: ${normalizedReviewer} (forced)`))
  } else {
    const { origin: detectedOrigin, method } = await detectOriginFull(
      prData.body ?? '',
      prData.head.ref,
      owner,
      repo,
      number,
      config,
      token,
      prData.user?.login,
    )
    origin = detectedOrigin
    console.log(chalk.dim(`  PR origin: ${origin} (via ${method})`))
  }

  const assignedReviewer = normalizedReviewer !== null
    ? normalizedReviewer
    : await assignReviewer(origin, config)

  if (!assignedReviewer) {
    console.log(chalk.dim(`  no reviewer assigned for origin "${origin}" — use --reviewer ${VENDOR_ALIAS_HINT} to force`))
    return
  }
  if (normalizedReviewer === null) {
    console.log(chalk.dim(`  assigned reviewer: ${assignedReviewer}`))
  }

  // Resolve steps — filter from workflow.yml by type if --steps is specified, then pin the
  // resolved reviewer on every review/recheck step so runWorkflow doesn't re-derive it
  const allSteps = loadWorkflow(process.cwd())
  const stepFilter = opts.steps?.split(',').map(s => s.trim().toLowerCase())
  const filteredSteps = resolveWorkflowSteps(allSteps, stepFilter, assignedReviewer)

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

  const { sha } = prData.head

  if (!acquirePRLock(owner, repo, number, sha)) {
    fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repo}`, pr: number, reason: 'in_progress_local' })
    console.log(chalk.yellow(`⚠  PR #${number} is already being reviewed by another process on this machine — skipping`))
    return
  }

  // Track which resources have actually been allocated so the SIGINT/SIGTERM
  // handler only releases what exists. The handler must be installed BEFORE
  // calling acquireRemoteLock: GitHub may create the pending status server-side
  // even if the network round-trip is interrupted, and without an installed
  // listener pr-lock would re-raise the signal and orphan the pending status
  // until it goes stale.
  let lockAttemptStarted = false
  let acquiredTmpDir: string | undefined
  let stopHeartbeat = () => {}
  // Shared with runWorkflow — the runner appends every sha for which it set
  // a remote pending status (e.g. after a conflict-resolve push). On normal
  // completion or workflow error, the runner's own finally releases them;
  // but if a signal fires mid-workflow we exit via process.exit and bypass
  // that finally, so the signal handler iterates this array too.
  const pushedShas: string[] = []
  const loopLockShas: string[] = []

  const rememberLoopLock = (lockSha: string): void => {
    if (!loopLockShas.includes(lockSha)) loopLockShas.push(lockSha)
  }
  const releaseRememberedLoopLock = async (lockSha: string, outcome: 'success' | 'failure'): Promise<void> => {
    const idx = loopLockShas.indexOf(lockSha)
    if (idx !== -1) loopLockShas.splice(idx, 1)
    try {
      await releaseRemoteLock(octokit, owner, repo, lockSha, outcome)
    } catch (err) {
      rememberLoopLock(lockSha)
      throw err
    }
  }
  const drainLoopLocks = async (outcome: 'success' | 'failure'): Promise<void> => {
    while (loopLockShas.length > 0) {
      const s = loopLockShas.shift()!
      try { await releaseRemoteLock(octokit, owner, repo, s, outcome) } catch { /* best-effort per sha */ }
    }
  }

  const onSignal = (signal: NodeJS.Signals): void => {
    void (async () => {
      try {
        stopHeartbeat()
        if (!opts.dryRun && lockAttemptStarted) {
          await releaseRemoteLock(octokit, owner, repo, sha, 'failure')
          await drainLoopLocks('failure')
          // Drain the shared array via shift() so the runner's finally (which
          // also drains via shift) doesn't double-release. Whichever loop
          // shifts a sha first owns its release; the other sees a shorter
          // array. This also prevents the reverse race — a signal arriving
          // after the runner has already released a sha as 'success' would
          // otherwise overwrite it with 'failure' here.
          while (pushedShas.length > 0) {
            const s = pushedShas.shift()!
            try { await releaseRemoteLock(octokit, owner, repo, s, 'failure') } catch { /* best-effort per sha */ }
          }
        }
      } catch { /* best-effort — must still exit even if remote release fails */ }
      try { releasePRLock(owner, repo, number, sha) } catch { /* ignore */ }
      if (acquiredTmpDir) try { rmSync(acquiredTmpDir, { force: true, recursive: true }) } catch { /* ignore */ }
      // 128 + signal number (SIGINT=2 → 130, SIGTERM=15 → 143) per POSIX convention
      process.exit(signal === 'SIGTERM' ? 143 : 130)
    })()
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  try {
    if (!opts.dryRun) {
      if (await checkRemoteLock(octokit, owner, repo, sha)) {
        releasePRLock(owner, repo, number, sha)
        fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repo}`, pr: number, reason: 'in_progress_remote' })
        console.log(chalk.yellow(`⚠  PR #${number} is already being reviewed on another machine — skipping`))
        return
      }
      try {
        // Set the flag BEFORE the await so a signal that interrupts the in-flight
        // request still triggers releaseRemoteLock (GitHub may have already
        // created the pending status server-side).
        lockAttemptStarted = true
        await acquireRemoteLock(octokit, owner, repo, sha)
      } catch (err: unknown) {
        releasePRLock(owner, repo, number, sha)
        throw err
      }
    }

    // Clone the repo
    const tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-run-'))
    acquiredTmpDir = tmpDir
    const cloneSpinner = ora('Cloning repo...').start()

    try {
      clonePRForReview({
        owner, repo, prNumber: number, baseRef: prData.base.ref,
        tmpDir, token, protocol: config.clone_protocol,
        onBaseFetchFailed: () => fileLog({ level: 'warn', event: 'base_branch_fetch_skipped', repo: `${owner}/${repo}`, pr: number, base: prData.base.ref }),
      })
      cloneSpinner.succeed('Repo ready')

      if (!opts.dryRun) stopHeartbeat = startRemoteLockHeartbeat(octokit, owner, repo, sha)
      let activeSpinner = ora('').start()

      const sharedCtx = {
        owner, repoName: repo, prNumber: number, token, config, origin,
        log: (msg: string) => { activeSpinner.stop(); console.log(msg); activeSpinner = ora('').start() },
        onPhaseChange: (label: string) => { activeSpinner.text = label },
        crosscheckShas: new Set<string>(),
        pushedShas,
        dryRun: opts.dryRun,
        // crazy/halfcrazy bypass per-step max_rounds; the outer ceiling is the only cap
        overrideMaxRounds: opts.roundMode ? Infinity : undefined,
        roundMode: opts.roundMode,
        overrideTimeoutMs: reviewerTimeoutMs,
      }

      let workflowResult = await runWorkflow({
        ...sharedCtx,
        pr,
        tmpDir,
        reviewStart: Date.now(),
        steps: filteredSteps,
        initialReviewComment: opts.initialReviewComment,
      })
      let { verdict, fixAppliedCount } = workflowResult
      let latestReviewComment = workflowResult.latestReviewComment ?? opts.initialReviewComment

      // Autonomous fix→recheck loop for --crazy / --halfcrazy
      if (opts.roundMode) {
        const mode = opts.roundMode
        const fixRecheckSteps = buildFixRecheckSteps(filteredSteps, allSteps, assignedReviewer)
        let loopRound = 1
        let loopSha = sha

        while (
          loopRound < CRAZY_ROUND_CEILING &&
          (!meetsCrazyStopCondition(verdict, mode) || (fixAppliedCount !== undefined && fixAppliedCount > 0))
        ) {
          // No-progress guard: if fix ran but applied nothing, looping is futile
          if (fixAppliedCount === 0) {
            fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repo}`, pr: number, reason: 'no_progress', mode, round: loopRound })
            console.log(chalk.dim(`  no progress in round ${loopRound} — stopping`))
            break
          }

          loopRound++
          console.log(chalk.dim(`\n  round ${loopRound}  previous verdict ${verdict ?? '--'} — continuing...`))

          // Refresh head SHA so the remote lock targets the commit fix pushed.
          // A review-only first round has no fix count and no new head yet; in
          // that case continue on the existing lock so round 2 can actually run
          // the synthesized fix/recheck follow-up.
          const { data: freshPR } = await octokit.rest.pulls.get({ owner, repo, pull_number: number })
          const freshSha = freshPR.head.sha
          const priorRoundRanFix = fixAppliedCount !== undefined
          if (freshSha === loopSha && priorRoundRanFix) {
            // Head didn't advance — fix made no changes despite applied_count > 0 (edge case)
            fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repo}`, pr: number, reason: 'no_progress', mode, round: loopRound })
            console.log(chalk.dim(`  head SHA unchanged — no progress, stopping`))
            break
          }
          const acquiredLoopLock = freshSha !== loopSha
          if (acquiredLoopLock) {
            loopSha = freshSha
            stopHeartbeat()
            if (await checkRemoteLock(octokit, owner, repo, loopSha)) {
              fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repo}`, pr: number, reason: 'in_progress_remote', mode, round: loopRound })
              console.log(chalk.yellow(`⚠  PR #${number} head ${loopSha.slice(0, 7)} is already locked — stopping loop`))
              break
            }
            rememberLoopLock(loopSha)
            await acquireRemoteLock(octokit, owner, repo, loopSha)
            stopHeartbeat = startRemoteLockHeartbeat(octokit, owner, repo, loopSha)
          }

          const loopPR = { ...pr, head: { ...pr.head, sha: loopSha } }
          workflowResult = await runWorkflow({
            ...sharedCtx,
            pr: loopPR,
            tmpDir,
            reviewStart: Date.now(),
            steps: fixRecheckSteps,
            initialReviewComment: latestReviewComment,
            round: loopRound,
          })
          ;({ verdict, fixAppliedCount } = workflowResult)
          latestReviewComment = workflowResult.latestReviewComment ?? latestReviewComment

          if (acquiredLoopLock) await releaseRememberedLoopLock(loopSha, 'success')
          const done = meetsCrazyStopCondition(verdict, mode)
          console.log(`  round ${loopRound}  verdict ${verdict ?? '--'}${done ? ' — done' : ' — continuing...'}`)
        }

        if (loopRound >= CRAZY_ROUND_CEILING && !meetsCrazyStopCondition(verdict, mode)) {
          fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repo}`, pr: number, reason: 'crazy_ceiling', mode, round: loopRound })
          console.log(chalk.yellow(`  ceiling reached (${CRAZY_ROUND_CEILING} rounds) — last verdict: ${verdict ?? '--'}`))
        }
      }

      activeSpinner.stop()
      console.log(`\n  ${formatVerdict(verdict as Verdict | null)}`)

      console.log(chalk.green(`\n✓ Workflow complete — ${prUrl}\n`))

      stopHeartbeat()
      if (!opts.dryRun) await releaseRemoteLock(octokit, owner, repo, sha, 'success')
    } catch (err: unknown) {
      stopHeartbeat()
      if (!opts.dryRun) {
        try { await releaseRemoteLock(octokit, owner, repo, sha, 'failure') } catch { /* best-effort */ }
        await drainLoopLocks('failure')
      }
      logError({ repo: `${owner}/${repo}`, pr: number, phase: 'run' }, err)
      console.error(chalk.red(`\n✗ ${err instanceof Error ? err.message : String(err)}\n`))
      releasePRLock(owner, repo, number, sha)
      if (acquiredTmpDir) rmSync(acquiredTmpDir, { force: true, recursive: true })
      process.exit(2)
    } finally {
      releasePRLock(owner, repo, number, sha)
      if (acquiredTmpDir) rmSync(acquiredTmpDir, { force: true, recursive: true })
    }
  } finally {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
  }
}
