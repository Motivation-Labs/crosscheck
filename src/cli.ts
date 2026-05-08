#!/usr/bin/env node
import { Command } from 'commander'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { runInit } from './commands/init.js'
import { runServe } from './commands/serve.js'
import { runWatch } from './commands/watch.js'
import { runReview } from './commands/review.js'
import { runStatus } from './commands/status.js'
import { runDiagnose } from './commands/diagnose.js'
import { runOptimize } from './commands/optimize.js'
import { runImpact } from './commands/impact.js'
import { runIssue } from './commands/issue.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as { version: string }

const program = new Command()

program
  .name('crosscheck')
  .description('Cross-vendor AI code review — Claude Code ↔ Codex')
  .version(`❤️  ${version}`)

program
  .command('init')
  .description('Check environment, verify CLI auth, write starter config')
  .option('-c, --config <path>', 'path to write config file')
  .action((opts: { config?: string }) => runInit(opts.config))

program
  .command('serve')
  .description('[BETA] Always-on webhook server (mac-mini / home server mode)')
  .option('-c, --config <path>', 'config file path')
  .action((opts: { config?: string }) => runServe(opts.config))

program
  .command('watch')
  .description('Local dev mode — listen for PRs via gh webhook forward')
  .option('-c, --config <path>', 'config file path')
  .action((opts: { config?: string }) => void runWatch(opts.config))

program
  .command('review <pr-url>')
  .description('Manually trigger a review for a single PR URL')
  .option('-c, --config <path>', 'config file path')
  .option('-r, --reviewer <vendor>', 'force a specific reviewer: codex | claude (bypasses auto-detection)')
  .action((prUrl: string, opts: { config?: string; reviewer?: string }) => void runReview(prUrl, opts.config, opts.reviewer))

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
  .option('--apply', 'write the improved instructions to ~/.crosscheck/instructions.md')
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
  .action((opts: { since?: string; dryRun?: boolean; yes?: boolean; config?: string }) => void runIssue(opts))

program.parse()
