#!/usr/bin/env node
import { Command } from 'commander'
import { runInit } from './commands/init.js'
import { runServe } from './commands/serve.js'
import { runWatch } from './commands/watch.js'
import { runReview } from './commands/review.js'
import { runStatus } from './commands/status.js'

const program = new Command()

program
  .name('crosscheck')
  .description('Cross-vendor AI code review — Claude Code ↔ Codex')
  .version('0.1.0')

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
  .description('Local dev mode — listen for PRs on the current repo')
  .option('-c, --config <path>', 'config file path')
  .option('--tunnel-url <url>', 'use an existing smee.io channel URL instead of auto-creating one')
  .action((opts: { config?: string; tunnelUrl?: string }) => void runWatch(opts.config, opts.tunnelUrl))

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

program.parse()
