<div align="right">
  <h5><a href="./README.zh.md">🌏 &nbsp;中文</a></h5>
</div>

<p align="center">
  <img src="./assets/logo.png" alt="crosscheck" width="160" />
</p>

# crosscheck

**A lightweight orchestration layer that makes your AI coding agents review each other's work — then fix it.**

When Claude Code opens a PR, Codex reviews it. When Codex opens a PR, Claude reviews it. If issues are found on a Claude-authored PR, Claude commits fixes and pushes them back. All of this runs on your laptop, against your existing subscriptions, with a single command.

```
GitHub PR  →  crosscheck watch  →  AI review posted  →  fixes committed
```

> Inspired by [Symphony](https://github.com/openai/symphony) — OpenAI's spec-driven multi-agent framework. Where Symphony coordinates agents at the product level, crosscheck stays at the level engineers already live in: pull requests, diffs, and code review. No new abstractions — just the CR + fix loop, automated.

---

## Why

Coding agents ship fast. They also make confident, plausible mistakes. The fix isn't a human reviewer on every AI-authored PR — it's the *other* AI reviewing it. Claude and Codex have complementary blind spots; cross-vendor review catches more issues than either model alone, without adding human latency to every commit.

crosscheck wires that loop:

| | |
|---|---|
| **Local execution, always listening** | Runs on your machine. `crosscheck watch` opens a tunnel and keeps running. No cloud, no infra, no SaaS. |
| **Subscription-funded** | Uses `claude` and `codex` CLIs against your existing Claude Pro/Max and ChatGPT Plus/Pro plans. No per-token API billing. Reviews are free once you're subscribed. |
| **Cross-vendor by default** | Claude reviews Codex PRs; Codex reviews Claude PRs. Each model brings different training and different failure modes. The overlap is where bugs hide. |
| **Self-improving** | `crosscheck diagnose` surfaces failure patterns from logs. `crosscheck optimize` feeds them to your AI and updates reviewer instructions automatically. |

---

## Quick start

```bash
# 1. Install crosscheck and the agent CLIs
npm install -g @motivation-labs/crosscheck
npm install -g @anthropic-ai/claude-code && claude        # Claude Pro/Max subscription
npm install -g @openai/codex && codex login --device-auth # ChatGPT Plus/Pro subscription
brew install gh && gh auth login                          # GitHub CLI

# 2. Check your environment
crosscheck init

# 3. Test against a single PR
crosscheck review https://github.com/your-org/repo/pull/42

# 4. Run continuously
crosscheck watch
```

`crosscheck watch` opens a `localhost.run` SSH tunnel (no install, no account), auto-registers a GitHub webhook, and starts listening. GitHub delivers PR events; crosscheck routes them to the right reviewer.

---

## How it works

```
┌────────────────────────────────────────────────────────────────┐
│  Your laptop                                                    │
│                                                                 │
│  crosscheck watch                                               │
│    ├── SSH tunnel (localhost.run)  ◄──── GitHub webhook         │
│    ├── Webhook server (:7891)                                   │
│    └── PR handler                                               │
│         ├── detect origin   (Claude Code? Codex? other?)        │
│         ├── clone PR branch                                     │
│         ├── run reviewer    (cross-vendor assignment)           │
│         ├── post review comment                                 │
│         └── address step    (fix issues, push [crosscheck] commit) │
└────────────────────────────────────────────────────────────────┘
```

**Routing** reads PR body patterns. `Generated with [Claude Code]` → Codex reviews. `Generated with [OpenAI Codex]` → Claude reviews. `allowed_authors` restricts reviews to your agent accounts.

**The address step** (optional, enabled via workflow config) runs after the review. The author agent reads its own review comment and commits fixes back to the PR branch. Commits are prefixed `[crosscheck]`. Hard cap: 5 address commits per PR.

**The feedback loop** closes via `crosscheck diagnose` → `crosscheck optimize`. Failure patterns and quality signals from `~/.crosscheck/logs/` feed back into improved reviewer instructions — no manual config editing required.

---

## watch output

```
$ crosscheck watch

  "Move fast and review things."

crosscheck watch

  repos     your-org/your-repo
  mode      cross-vendor
  quality   balanced
  config    ./crosscheck.config.yml  ← edit to change above

  ✓ tunnel ready: https://abc123.lhr.life
  ✓ webhook registered for your-org/your-repo
Waiting for PR events — Ctrl+C to stop.

PR #47 opened: add retry logic for flaky network calls
  origin=claude  reviewer=codex
  codex reviewing... (12s)
  review complete (12s)
  posted → github.com/your-org/your-repo/pull/47
  NEEDS WORK

PR #48 opened: implement caching layer
  origin=codex  reviewer=claude
  claude reviewing... (18s)
  review complete (18s)
  posted → github.com/your-org/your-repo/pull/48
  APPROVE
```

---

## Commands

```bash
crosscheck init                     # check prerequisites, write starter config
crosscheck review <pr-url>          # one-shot review of a specific PR
crosscheck watch                    # local dev — tunnel + auto-webhook + listening
crosscheck serve                    # always-on — fixed port, register webhook once
crosscheck status                   # auth state, config, log summary, CLI versions
crosscheck diagnose                 # surface failure patterns from review logs
crosscheck optimize [--apply]       # update reviewer instructions from diagnose output
crosscheck impact [--money]         # time saved, issues caught, code quality trends
```

---

## Configuration

`crosscheck.config.yml` lives in your project root. Coding agents can read and modify it directly.

```yaml
# Which repos/orgs to watch (at least one required)
orgs:
  - your-org                      # covers every repo in the org

# Only review PRs from these GitHub accounts
routing:
  allowed_authors:
    - your-claude-bot-account
    - your-codex-bot-account

# Review depth
quality:
  tier: balanced                  # fast | balanced | thorough

# Optional spend cap
budget:
  per_review_usd: 2.0
  codex_monthly_usd: 50

# Tunnel backend (watch mode only)
# localhost.run — zero install, reconnects automatically (default)
# smee         — stable channel URL, queues events while offline
tunnel:
  backend: localhost.run
```

Full configuration reference: [get-started.md](./get-started.md)

---

## Self-improving reviews

Every review outcome is logged to `~/.crosscheck/logs/YYYY-MM-DD.ndjson`. Over time, patterns emerge — which commands the reviewer tries to run (and fails), verdict distributions, review duration trends.

```bash
# See what's going wrong
$ crosscheck diagnose

crosscheck diagnose  (2026-01-01 → 2026-05-08 · 3 log files)

  Reviews       47 total  —  28 APPROVE  14 NEEDS WORK  5 BLOCK
  Failure rate  codex 12%  /  claude 4%

  Suggestions
  ─────────────────────────────────────────────────────────────
  ✦ codex runs `npm test` during review (7 occurrences)
    → add to instructions: "Do not run npm, tsc, or test commands."
  ✦ 3 reviews timed out on large PRs (>400 lines changed)
    → consider quality.tier: fast for PRs above a size threshold

# Apply the suggested fixes automatically
$ crosscheck optimize --apply
  agent  claude (lower failure rate: 4% vs codex 12%)
  writing ~/.crosscheck/instructions.md
  + Do not run npm, tsc, jest, or any build/test commands.
  + Flag PRs over 400 lines changed as too large to review thoroughly.
  done

# Measure the compounding value
$ crosscheck impact --money

crosscheck impact  (all time · 47 reviews)

  Time saved
  ──────────────────────────────────────────────
  Reviews run              47
  Avg AI review time       ~14 min
  Assumed human time       60 min  ⓘ
  Total time saved         ~43 h

  Issues caught
  ──────────────────────────────────────────────
  APPROVE              28   (60%)
  NEEDS WORK           14   (30%)  ← actionable feedback
  BLOCK                 5   (11%)  ← potential bugs / breaking changes
  Total issues caught  19

  Estimated value: ~$8,450
  (43h × $150/hr + 19 issues × $150/issue)
```

---

## Deployment

### Laptop — `crosscheck watch`

Zero configuration. SSH tunnel through `localhost.run` handles NAT — no port-forwarding, no cloud account. If the tunnel goes silent without exiting, the health check detects it within ~2 minutes and forces a reconnect + webhook re-registration.

```bash
crosscheck watch
# → opens tunnel, registers webhook, starts listening
```

### Server — `crosscheck serve`

Bind to a fixed port on a machine with a public IP. Register the webhook once.

```bash
crosscheck serve
# → listens on :7891, you register https://your-server/webhook manually
```

### smee.io — stable relay (optional)

`localhost.run` drops events if your laptop is offline when a PR opens. [smee.io](https://smee.io) queues them and replays on reconnect — useful when the reviewer machine isn't always on.

```bash
npm install -g smee-client
# Visit https://smee.io/new — copy the channel URL
```

```yaml
# crosscheck.config.yml
tunnel:
  backend: smee
  smee_channel: https://smee.io/your-channel-id
```

---

## Requirements

| | Minimum |
|---|---|
| Node.js | 18+ |
| Claude Code CLI | latest — `npm install -g @anthropic-ai/claude-code` |
| Codex CLI | latest — `npm install -g @openai/codex` |
| GitHub CLI | 2.65+ — `brew install gh` |

`GITHUB_TOKEN` is derived automatically when `gh auth login` has been run. No manual export required.

---

## Documentation

| | |
|---|---|
| **[get-started.md](./get-started.md)** | Full setup guide — prerequisites, all commands and flags, complete config reference, how it works, FAQ |
| **[crosscheck.config.example.yml](./crosscheck.config.example.yml)** | Annotated config file with every option |
| **[AGENT.md](./AGENT.md)** | Harness document used by `crosscheck optimize` — how the AI improves reviewer instructions |

---

## Contributing

Issues and PRs welcome at [github.com/Motivation-Labs/crosscheck](https://github.com/Motivation-Labs/crosscheck).

---

## License

[MIT](./LICENSE) — Copyright (c) 2025–2026 Motivation Labs LLC.
