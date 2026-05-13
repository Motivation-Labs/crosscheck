<div align="right">
  <h5><a href="./README.zh.md">🌏 &nbsp;中文</a></h5>
</div>

<p align="center">
  <img src="./assets/logo.png" alt="crosscheck" width="160" />
</p>

<p align="center"><em>Building crosscheck with crosscheck.</em></p>

# crosscheck

**Automated AI code review for teams using Claude Code and Codex — configured your way, zero new infrastructure.**

When your AI agent opens a PR, the rival AI reviews it. If issues are found, the original agent fixes them and opens a follow-up PR. The whole loop runs against your existing subscriptions with a single command.

---

## Highlights

- **Customizable review workflow** — configure the full pipeline: review-only, review + auto-fix, or review + fix + recheck. Per-step instructions let you tune what the reviewer focuses on without editing prompts manually.
- **Cross-vendor and single-vendor modes** — cross-vendor mode routes each PR to the rival AI for independent review. Single-vendor mode uses whichever AI you have. Switch with one config line.
- **Subscription-funded, not token-billed** — runs through the `claude` and `codex` CLIs against your Claude Pro/Max and ChatGPT Plus/Pro plans. No API keys, no per-review cost.
- **`watch` for personal use, `serve` for your team** — `crosscheck watch` runs on your laptop and opens a tunnel automatically, ideal for solo developers. `crosscheck serve` binds to a fixed port on a shared machine so the whole team gets coverage without anyone's laptop staying on.

---

## Quick start

```bash
# 1. Install crosscheck and the agent CLIs
npm install -g @motivation-labs/crosscheck
npm install -g @anthropic-ai/claude-code && claude        # Claude Pro/Max subscription
npm install -g @openai/codex && codex login --device-auth # ChatGPT Plus/Pro subscription
brew install gh && gh auth login                          # GitHub CLI

# 2. Guided setup — repos, review mode, workflow pipeline
crosscheck onboard

# 3. Start watching
crosscheck watch        # personal laptop
crosscheck serve        # always-on team server
```

`crosscheck onboard` walks you through repo selection, vendor mode, pipeline steps, and tunnel choice. After that, `watch` or `serve` is all you need.

---

## What it looks like

```
$ crosscheck watch

  "Move fast and review things."

  profile   personal · cross-vendor · balanced
  users     your-github-login (5 repos)
  auto-fix  on_issues · same-as-author · pull_request
  config    ./crosscheck.config.yml

  ✓ tunnel ready: https://abc123.lhr.life
  ✓ webhook registered for your-org/your-repo
  Waiting for PR events — Ctrl+C to stop.

PR #47 opened: add retry logic for flaky network calls
  origin=claude  reviewer=codex
  codex reviewing... (12s)
  NEEDS WORK
  auto-fix  claude fixing...
  fix PR #48 opened → github.com/your-org/your-repo/pull/48

PR #49 opened: implement caching layer
  origin=codex  reviewer=claude
  claude reviewing... (18s)
  APPROVE
```

---

## Commands

```bash
crosscheck init                     # check prerequisites, write starter config
crosscheck onboard                  # guided setup — pick repos, mode, and pipeline
crosscheck review <pr-url>          # one-shot review of a specific PR
crosscheck watch                    # personal use — tunnel + webhook + listening on your laptop
crosscheck serve                    # team use — fixed port, register webhook once
crosscheck status                   # auth state, config summary, CLI versions
```

**Continuous improvement** *(experimental)*

```bash
crosscheck diagnose                 # surface failure patterns from review logs
crosscheck optimize [--apply]       # rewrite reviewer instructions based on diagnose output
crosscheck impact [--money]         # time saved, issues caught, code quality trends
crosscheck issue                    # draft and file a bug report from recent error logs
```

---

## Configuration

Config lives at `~/.crosscheck/config.yml` — one file covers all your repos. Run `crosscheck init` to generate it, or let `crosscheck onboard` write it for you.

```yaml
orgs:
  - your-org

routing:
  allowed_authors:
    - your-github-login

quality:
  tier: balanced          # fast | balanced | thorough

# Which protocol crosscheck uses when cloning PR repos for review
# ssh   — uses your local SSH keys (default)
# https — uses your GitHub token; pick if SSH cannot reach target repos
clone_protocol: ssh

post_review:
  auto_fix:
    enabled: true
    trigger: on_issues    # on_issues | always | never
    fixer: same-as-author
    delivery:
      mode: pull_request
```

Full reference: [get-started.md](./get-started.md)

---

## Deployment

**Personal (`crosscheck watch`)** — runs on your laptop. SSH tunnel through `localhost.run` handles everything — no port-forwarding, no cloud account. Health check reconnects automatically if the tunnel drops.

**Team (`crosscheck serve`)** — bind to a fixed port on a machine with a public IP. Register the webhook once and the whole team is covered without anyone's laptop staying on.

---

## Requirements

| | Minimum |
|---|---|
| Node.js | 18+ |
| Claude Code CLI | latest — `npm install -g @anthropic-ai/claude-code` |
| Codex CLI | latest — `npm install -g @openai/codex` |
| GitHub CLI | 2.65+ — `brew install gh` |

`GITHUB_TOKEN` is derived automatically from `gh auth login`. No manual export needed.

---

## Documentation

| | |
|---|---|
| **[get-started.md](./get-started.md)** | Full setup guide — prerequisites, all flags, complete config reference, FAQ |
| **[crosscheck.config.example.yml](./crosscheck.config.example.yml)** | Annotated config with every option |
| **[CHANGELOG.md](./CHANGELOG.md)** | Release notes |

---

## Contributing

Issues and PRs welcome at [github.com/Motivation-Labs/crosscheck](https://github.com/Motivation-Labs/crosscheck).

---

## License

[MIT](./LICENSE) — Copyright (c) 2025–2026 Motivation Labs LLC.
