# crosscheck

Cross-vendor AI code review orchestrator. When Claude Code opens a PR, Codex reviews it. When Codex opens a PR, Claude reviews it. Runs locally using your existing subscriptions — no separate API billing required.

---

## Why

AI coding agents are shipping code faster than human reviewers can keep up. But each agent has blind spots — Claude misses things Codex catches, and vice versa. crosscheck closes that loop: every AI-generated PR gets reviewed by a different AI before it lands, automatically.

This isn't about replacing human review. It's about filtering out the noise — type errors, security gaps, logic inconsistencies — so humans spend review time on what actually requires judgment.

---

## What it does

- Listens for new PRs on any GitHub repo via webhook
- Detects whether the PR was authored by Claude Code or Codex (from attribution footers)
- Assigns the opposite AI to review it
- Clones the PR branch, runs the reviewer locally, posts a comment back to the PR

**Single-vendor mode** is also supported: one AI reviews all PRs regardless of origin, useful when you only have one AI agent on the team.

---

## Goals

- **Use your existing subscriptions** — runs `claude` and `codex` CLIs locally, so you pay through your Claude Pro/Max or ChatGPT Plus plan, not per-token API billing
- **Zero infrastructure** — a single command on any machine with both CLIs installed; no cloud service, no database, no queue
- **Config-as-code** — one YAML file that's easy to read and modify, including by the agents themselves
- **Two modes** — always-on server (mac-mini, home server) or local dev mode (your laptop while you work)
- **Pluggable quality tiers** — fast / balanced / thorough maps to appropriate models and depth of review

## Non-goals

- Not a replacement for human code review
- Not a full CI/CD pipeline — it posts review comments, it does not block merges
- Not a hosted service — crosscheck runs on your machine against your CLIs
- Not model-agnostic in a generic sense — designed specifically for Claude Code and Codex CLI interop

---

## Requirements

| Dependency | Install |
|---|---|
| [Claude Code CLI](https://claude.ai/code) | `npm install -g @anthropic-ai/claude-code` |
| [Codex CLI](https://github.com/openai/codex) | `npm install -g @openai/codex` |
| [GitHub CLI](https://cli.github.com) | `brew install gh` |
| Node.js 18+ | [nodejs.org](https://nodejs.org) |

Both CLIs must be authenticated before crosscheck can run reviews.

```bash
claude          # follow prompts to log in to Claude.ai
codex login --device-auth   # OAuth login with your ChatGPT account
gh auth login   # authenticate GitHub CLI
```

---

## Install

**npm (recommended):**
```bash
npm install -g crosscheck
```

**npx (no install):**
```bash
npx crosscheck init
```

**From source:**
```bash
git clone https://github.com/beingzy/crosscheck
cd crosscheck
npm install
npm run build
npm link
```

---

## Quick start

### 1. Check your environment

```bash
crosscheck init
```

This verifies that all required CLIs are installed and authenticated, and writes a starter `crosscheck.config.yml` to the current directory.

```
crosscheck — environment check

  ✓ codex CLI            codex-cli 0.128.0-alpha.1 — logged in
  ✓ claude CLI           2.1.131 (Claude Code)
  ✓ gh CLI               gh version 2.65.0
  ✓ GITHUB_TOKEN         set
  ✗ WEBHOOK_SECRET       missing (only needed for serve/watch)
      → Set CROSSCHECK_WEBHOOK_SECRET
```

### 2. Set environment variables

```bash
export GITHUB_TOKEN=ghp_...                 # github.com/settings/tokens (repo + pull-requests scope)
export CROSSCHECK_WEBHOOK_SECRET=your-secret   # any random string — must match your GitHub webhook config
```

Add these to your shell profile (`~/.zshrc`, `~/.bashrc`) to persist them.

### 3. Review a PR manually

The fastest way to verify everything works:

```bash
crosscheck review https://github.com/owner/repo/pull/123
```

Override which AI reviews it:

```bash
crosscheck review https://github.com/owner/repo/pull/123 --reviewer codex
crosscheck review https://github.com/owner/repo/pull/123 --reviewer claude
```

### 4. Watch mode (local dev)

Listens for PRs on the repo in the current directory. Uses [smee.io](https://smee.io) to receive webhooks on your local machine.

```bash
crosscheck watch
```

```
crosscheck watch

  mode      cross-vendor
  quality   balanced
  port      7891

To receive GitHub webhooks locally, use smee.io:
  npx smee -u https://smee.io/<channel> -t http://localhost:7891/webhook

Waiting for PR events...
```

### 5. Serve mode (always-on machine)

For mac-mini, home server, or any machine that stays on. Exposes a stable webhook endpoint.

```bash
crosscheck serve
```

```
crosscheck serving

  mode      cross-vendor
  quality   balanced
  port      7891
  endpoint  http://your-machine.local:7891/webhook

Register this URL as a GitHub webhook (content-type: application/json).
Listening for pull_request events...
```

Register the endpoint at `github.com/<org>/<repo>/settings/hooks` with:
- Payload URL: `http://your-server:7891/webhook`
- Content type: `application/json`
- Secret: your `CROSSCHECK_WEBHOOK_SECRET` value
- Events: `Pull requests`

---

## Configuration

`crosscheck.config.yml` — place in your project root or working directory.

```yaml
# single-vendor: one AI reviews all PRs
# cross-vendor:  Claude ↔ Codex review each other
mode: cross-vendor

vendors:
  codex:
    enabled: true
    auth: subscription     # subscription | api-key
  claude:
    enabled: true
    model: sonnet          # haiku | sonnet | opus
    effort: medium         # low | medium | high | max

quality:
  tier: balanced           # fast | balanced | thorough

budget:
  codex_monthly_usd: 20    # null = unlimited
  per_review_usd: 2.00

# Which PR body patterns trigger which reviewer
routing:
  codex_reviews_patterns:
    - "Generated with \\[Claude Code\\]"
  claude_reviews_patterns:
    - "Generated with \\[OpenAI Codex\\]"
```

Config is intentionally flat and machine-readable. Coding agents can modify it directly.

---

## Commands

| Command | Description |
|---|---|
| `crosscheck init` | Environment check + write starter config |
| `crosscheck review <url>` | Manually review a single PR |
| `crosscheck review <url> --reviewer codex\|claude` | Force a specific reviewer |
| `crosscheck watch` | Local dev mode — listen on current repo |
| `crosscheck serve` | Always-on webhook server |

---

## How it works

```
GitHub webhook (pull_request event)
        │
        ▼
  crosscheck webhook server
        │
        ├── reads PR body → detects origin (Claude / Codex / human)
        │
        ├── assigns reviewer (opposite vendor in cross-vendor mode)
        │
        ├── gh repo clone + git checkout pr-branch
        │
        ├── codex review --base <base-branch>
        │   or
        │   claude --print --bare --model <model>
        │
        └── posts review comment to PR via GitHub API
```

---

## License

MIT
