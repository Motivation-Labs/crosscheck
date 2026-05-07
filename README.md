# crosscheck

Cross-vendor AI code review orchestrator. When Claude Code opens a PR, Codex reviews it. When Codex opens a PR, Claude reviews it. Runs locally using your existing subscriptions — no separate API billing required.

```bash
npm install -g @motivation-labs/crosscheck          # stable
npm install -g @motivation-labs/crosscheck@beta     # latest features
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
# crosscheck
npm install -g @motivation-labs/crosscheck

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
# Local dev — tunnels via localhost.run (SSH), auto-registers webhook
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

| Dependency | Why it's needed | Install |
|---|---|---|
| Node.js 18+ | Runs crosscheck itself | [nodejs.org](https://nodejs.org) |
| Claude Code CLI | Performs AI code review on Codex PRs | `npm install -g @anthropic-ai/claude-code` |
| Codex CLI | Performs AI code review on Claude PRs | `npm install -g @openai/codex` |
| GitHub CLI (`gh`) | Clones PR branches, posts review comments, registers webhooks | `brew install gh` |
| `GITHUB_TOKEN` | Authenticates GitHub API calls (webhook registration, comment posting) | [github.com/settings/tokens](https://github.com/settings/tokens) — needs `repo` + `write:org` scopes |

### `watch` mode only

`watch` mode needs a public URL so GitHub can deliver webhook events to your laptop. Since laptops are behind NAT, a tunnel is required. crosscheck uses `localhost.run` — no install, no account, just SSH (pre-installed on macOS/Linux):

```
GitHub → ssh tunnel → localhost:7891
```

No tunnel is needed for `serve` mode, which assumes the machine already has a publicly reachable IP.

---

## License

MIT
