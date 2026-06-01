#!/usr/bin/env node
import { Command, Option } from 'commander'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { basename, dirname, join } from 'path'
import { runInit } from './commands/init.js'
import { runOnboard } from './commands/onboard.js'
import { runServe } from './commands/serve.js'
import { runWatch } from './commands/watch.js'
import { runReview } from './commands/review.js'
import { runStatus } from './commands/status.js'
import { runDiagnose } from './commands/diagnose.js'
import { runOptimize } from './commands/optimize.js'
import { runImpact } from './commands/impact.js'
import { runIssue } from './commands/issue.js'
import { runRun } from './commands/run.js'
import { runScan } from './commands/scan.js'
import { runKickass } from './commands/kickass.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as { version: string }

const invokedAs = basename(process.argv[1] ?? 'crosscheck').replace(/\.js$/, '')
const programName = invokedAs === 'ck' ? 'ck' : 'crosscheck'

const program = new Command()

program
  .name(programName)
  .description('Cross-vendor AI code review — Claude Code ↔ Codex')
  .version(`❤️  ${version}`)

program
  .command('init')
  .description('Check environment, verify CLI auth, write starter config')
  .option('-c, --config <path>', 'path to write config file')
  .action((opts: { config?: string }) => runInit(opts.config))

program
  .command('onboard')
  .description('Guided setup — select repos to monitor and write config')
  .option('-c, --config <path>', 'config file path to write')
  .option('-y, --yes', 'skip confirmation prompts, accept defaults')
  .option('--personal', 'pre-select personal deployment mode, skip persona prompt')
  .option('--team', 'pre-select team deployment mode, skip persona prompt')
  .option('--reconfigure', 're-run setup (accepted for compatibility; onboard always reconfigures)')
  .action((opts: { config?: string; yes?: boolean; personal?: boolean; team?: boolean; reconfigure?: boolean }) => void runOnboard(opts))

program
  .command('serve')
  .description('[BETA] Always-on webhook server (mac-mini / home server mode)')
  .option('-c, --config <path>', 'config file path')
  .option('--personal', 'personal mode this session only (does not save to config)')
  .option('--team', 'team mode this session only (does not save to config)')
  .option('--reconfigure', 're-run deployment setup and save new choice to config')
  .option('--backtrace', 'enable startup scan for unreviewed open PRs this session (overrides backtrace.enabled: false)')
  .option('--no-backtrace', 'skip startup scan for unreviewed open PRs this session (overrides backtrace.enabled: true)')
  .action((opts: { config?: string; personal?: boolean; team?: boolean; reconfigure?: boolean; backtrace?: boolean }) => void runServe(opts))

program
  .command('watch')
  .description('Local dev mode — listen for PRs via gh webhook forward')
  .option('-c, --config <path>', 'config file path')
  .option('--personal', 'personal mode this session only (does not save to config)')
  .option('--team', 'team mode this session only (does not save to config)')
  .option('--reconfigure', 're-run deployment setup and save new choice to config')
  .option('--backtrace', 'enable startup scan for unreviewed open PRs this session (overrides backtrace.enabled: false)')
  .option('--no-backtrace', 'skip startup scan for unreviewed open PRs this session (overrides backtrace.enabled: true)')
  .action((opts: { config?: string; personal?: boolean; team?: boolean; reconfigure?: boolean; backtrace?: boolean }) => void runWatch(opts))

program
  .command('review <pr-url>')
  .description('Manually trigger a review for a single PR URL')
  .option('-c, --config <path>', 'config file path')
  .option('-r, --reviewer <vendor>', 'force a specific reviewer: codex | claude (bypasses auto-detection)')
  .option('--vendor <vendor>', 'alias for --reviewer')
  .action((prUrl: string, opts: { config?: string; reviewer?: string; vendor?: string }) => void runReview(prUrl, opts.config, opts.reviewer ?? opts.vendor))

program
  .command('run <pr-url>')
  .description('Execute the full configured workflow against a single PR (review → fix → recheck)')
  .option('-c, --config <path>', 'config file path')
  .option('-r, --reviewer <vendor>', 'force a specific reviewer: codex | claude (bypasses attribution detection)')
  .option('--vendor <vendor>', 'alias for --reviewer')
  .option('--steps <list>', 'run only these step types, comma-separated: review,fix,recheck')
  .option('--dry-run', 'run the review but do not post a comment or apply fixes')
  .option('--expected-head-sha <sha>', 'skip if the PR head changed since selection')
  .option('--crazy', 'loop fix→recheck until APPROVE; disables all timeout constraints')
  .option('--half-crazy', 'loop fix→recheck until verdict is not BLOCK; disables all timeout constraints')
  .option('--halfcrazy', '(deprecated alias for --half-crazy)')
  .option('--timeout <duration>', 'reviewer subprocess timeout, e.g. 300s or 10m (default: 180s for claude, tier-based for codex)')
  .option('--no-timeout', 'remove the reviewer subprocess timeout cap (implied by --crazy/--half-crazy; used internally by kickass fix legs)')
  .addOption(new Option('--trigger <source>').hideHelp())  // internal: set by kickass/watch/serve
  .action((prUrl: string, opts: { config?: string; reviewer?: string; vendor?: string; steps?: string; dryRun?: boolean; expectedHeadSha?: string; crazy?: boolean; halfCrazy?: boolean; halfcrazy?: boolean; timeout?: string | false; noTimeout?: boolean; trigger?: string }) => {
    const roundMode = opts.crazy ? 'crazy' : (opts.halfCrazy || opts.halfcrazy) ? 'halfcrazy' : undefined
    // Commander sets opts.timeout = false (not opts.noTimeout) when --no-timeout is passed
    const noTimeout = opts.noTimeout || opts.timeout === false
    const trigger = (opts.trigger as import('./lib/runner.js').WorkflowTrigger | undefined) ?? 'run'
    void runRun(prUrl, { ...opts, reviewer: opts.reviewer ?? opts.vendor, roundMode, noTimeout, timeout: typeof opts.timeout === 'string' ? opts.timeout : undefined, trigger })
  })

program
  .command('scan')
  .description('Scan monitored open PRs and show stale crosscheck workflow state')
  .option('--tidy', 'show only stale PRs that need attention')
  .option('--force', 'bypass the 1-minute scan cache')
  .option('--stale-after <duration>', 'duration like 30m, 2h, 1d', '24h')
  .option('--json', 'emit raw scan result for scripts')
  .action((opts: { tidy?: boolean; force?: boolean; staleAfter?: string; json?: boolean }) => void runScan(opts))

program
  .command('kickass')
  .description('Select actionable PRs from the operator queue and advance them')
  .option('--force', 'bypass the 1-minute scan cache')
  .option('--stale-after <duration>', 'duration like 30m, 2h, 1d', '24h')
  .option('--dry-run', 'print selected actions without running them')
  .option('--crazy', 'loop fix→recheck per PR until APPROVE; disables all timeout constraints')
  .option('--half-crazy', 'loop fix→recheck per PR until verdict is not BLOCK; disables all timeout constraints')
  .option('--halfcrazy', '(deprecated alias for --half-crazy)')
  .option('--timeout <duration>', 'reviewer subprocess timeout, e.g. 300s or 10m (default: 180s for claude, tier-based for codex)')
  .option('--concurrent [n]', 'run PRs in parallel; omit n for one agent per selected PR, or set a cap (e.g. --concurrent 3)')
  .action((opts: { force?: boolean; staleAfter?: string; dryRun?: boolean; crazy?: boolean; halfCrazy?: boolean; halfcrazy?: boolean; timeout?: string; concurrent?: string | true }) => {
    const roundMode = opts.crazy ? 'crazy' : (opts.halfCrazy || opts.halfcrazy) ? 'halfcrazy' : undefined
    const concurrent = opts.concurrent === undefined ? undefined
      : opts.concurrent === true ? 0
      : Number(opts.concurrent)
    void runKickass({ ...opts, roundMode, concurrent })
  })

program
  .command('status')
  .description('Show auth state, config summary, and CLI versions')
  .option('-c, --config <path>', 'config file path')
  .action((opts: { config?: string }) => void runStatus(opts.config))

program
  .command('diagnose')
  .description('Analyze review logs — surface failure patterns, error trends, and improvement suggestions')
  .option('--json', 'output full report as JSON')
  .option('--since <date>', 'only analyze logs from this date onward (YYYY-MM-DD)')
  .action((opts: { json?: boolean; since?: string }) => void runDiagnose(opts))

program
  .command('optimize')
  .description('Use AI to improve review instructions based on diagnose output')
  .option('--apply', 'write the improved instructions to the review step in ~/.crosscheck/workflow.yml')
  .option('--dry-run', 'show diff without writing (default behavior)')
  .option('--agent <vendor>', 'force a specific agent: claude | codex')
  .option('--since <date>', 'limit the diagnose window (YYYY-MM-DD)')
  .option('-c, --config <path>', 'config file path')
  .action((opts: { apply?: boolean; dryRun?: boolean; agent?: string; since?: string; config?: string }) => void runOptimize(opts))

program
  .command('impact')
  .description('Report time saved, issues caught, and code quality trend from review history')
  .option('--json', 'output full report as JSON')
  .option('--since <date>', 'only analyze logs from this date onward (YYYY-MM-DD)')
  .option('--money', 'include a rough monetary estimate')
  .option('-c, --config <path>', 'config file path')
  .action((opts: { json?: boolean; since?: string; money?: boolean; config?: string }) => void runImpact(opts))

program
  .command('issue')
  .description('Detect errors in recent logs, draft a GitHub issue with AI, and submit after confirmation')
  .option('--since <date>', 'only look at logs from this date onward (YYYY-MM-DD, default: 3 days ago)')
  .option('--dry-run', 'print the draft without submitting')
  .option('-y, --yes', 'skip interactive questions and confirmation')
  .option('-c, --config <path>', 'config file path')
  .option('--opportunities', 'analyze logs for reliability patterns and improvement opportunities instead of error patterns')
  .action((opts: { since?: string; dryRun?: boolean; yes?: boolean; config?: string; opportunities?: boolean }) => void runIssue(opts))

program.parse()
