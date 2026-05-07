# crosscheck

Cross-vendor AI code review orchestrator. When Claude Code opens a PR, Codex reviews it. When Codex opens a PR, Claude reviews it. Runs locally using your existing subscriptions — no separate API billing required.

```bash
npm install -g crosscheck          # stable
npm install -g crosscheck@beta     # latest features
crosscheck init
crosscheck review https://github.com/owner/repo/pull/123 --reviewer codex
```

---

**[→ Full documentation: get-started.md](./get-started.md)**

Covers prerequisites, install, all commands and flags, full config reference, and how it works under the hood.

---

## Quick start

**1. Install CLIs and authenticate**

```bash
# Claude Code — uses your claude.ai Pro/Max subscription
npm install -g @anthropic-ai/claude-code && claude

# Codex — uses your ChatGPT Plus/Pro subscription
npm install -g @openai/codex && codex login --device-auth

# GitHub CLI
brew install gh && gh auth login
```

**2. Set env vars**

```bash
export GITHUB_TOKEN=ghp_...              # needs repo + pull-requests:write scope
export CROSSCHECK_WEBHOOK_SECRET=secret  # any random string
```

**3. Init and test**

```bash
crosscheck init
crosscheck review https://github.com/owner/repo/pull/123 --reviewer codex
```

**4. Run continuously**

```bash
# Local dev — auto-creates smee.io tunnel, auto-registers webhook
crosscheck watch

# Always-on machine — listens on fixed port, you register webhook once
crosscheck serve
```

---

## Goals

- **Use your existing subscriptions** — no per-token API billing; runs `claude` and `codex` CLIs locally
- **Zero infrastructure** — a single command on any machine with both CLIs installed
- **Config-as-code** — one flat YAML file, readable and writable by coding agents
- **Two deployment modes** — `watch` for laptops, `serve` for always-on machines

## Non-goals

- Not a replacement for human code review
- Not a merge gate — posts comments, does not block PRs
- Not a hosted service — runs on your machine, against your CLIs

---

## Requirements

| | Install |
|---|---|
| Node.js 18+ | [nodejs.org](https://nodejs.org) |
| Claude Code CLI | `npm install -g @anthropic-ai/claude-code` |
| Codex CLI | `npm install -g @openai/codex` |
| GitHub CLI | `brew install gh` |

---

## License

MIT
