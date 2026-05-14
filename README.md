<div align="right">
  <h5><a href="./README.zh.md">🌏 &nbsp;中文</a></h5>
</div>

<p align="center">
  <img src="./assets/logo.png" alt="crosscheck" width="160" />
</p>

<p align="center"><em>Building crosscheck with crosscheck.</em></p>

# crosscheck

**Auto Code Review Pipeline — customizable PR → Review → Fix → Recheck loop, single-vendor or cross-vendor, zero new infrastructure.**

Define the review pipeline in `workflow.yml`: review-only, review + fix, or the full review + fix + recheck cycle. Each step runs through the `claude` or `codex` CLI against your existing subscriptions — no API keys, no per-review cost.

---

## Highlights

- **Configurable pipeline** — compose steps in `workflow.yml`: a `review` step, an optional `fix` step, and an optional `recheck` step. Add per-step `instructions:` and `when:` conditions to control exactly what runs and when.
- **Single-vendor and cross-vendor modes** — single-vendor uses whatever AI you have enabled. Cross-vendor routes each PR to the rival AI for an independent review (Claude reviews Codex PRs, Codex reviews Claude PRs). Switch with one config line.
- **Subscription-funded, not token-billed** — runs through the `claude` and `codex` CLIs against your Claude Pro/Max and ChatGPT Plus/Pro plans. No API keys, no per-review cost.
- **`watch` for personal use, `serve` for your team** — `crosscheck watch` runs on your laptop with an auto-tunnel, ideal for solo use. `crosscheck serve` binds to a fixed port on a shared machine so the whole team is covered.

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
  pipeline  review → fix → recheck
  users     your-github-login (5 repos)
  config    ./crosscheck.config.yml

  ✓ tunnel ready: https://abc123.lhr.life
  ✓ webhook registered for your-org/your-repo
  Waiting for PR events — Ctrl+C to stop.

PR #47 opened: add retry logic for flaky network calls
  origin=claude  reviewer=codex
  codex reviewing... (12s)       NEEDS WORK   (8.4K)
  claude fixing...               fixed ✓      (11.2K)
  codex rechecking... (9s)       APPROVE      (6.1K)

PR #49 opened: implement caching layer
  origin=codex  reviewer=claude
  claude reviewing... (18s)      APPROVE      (9.8K)
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

### Pipeline (`workflow.yml`)

The pipeline lives in `workflow.yml` alongside your config. Compose `review`, `fix`, and `recheck` steps in any order and add per-step instructions and `when:` conditions.

```yaml
# workflow.yml — define the review pipeline
steps:
  - name: review
    type: review
    reviewer: auto          # auto | claude | codex | origin

  - name: fix
    type: fix
    reviewer: origin        # fix with the same vendor that wrote the PR
    when: review.verdict == "NEEDS_WORK" or review.verdict == "BLOCK"

  - name: recheck
    type: recheck
    reviewer: auto
    when: fix.applied_count > 0
```

### Config (`crosscheck.config.yml`)

Config lives at `~/.crosscheck/config.yml` — one file covers all your repos. Run `crosscheck init` to generate it, or let `crosscheck onboard` write it for you.

```yaml
orgs:
  - your-org

routing:
  allowed_authors:
    - your-github-login

vendors:
  claude:
    enabled: true
  codex:
    enabled: true           # cross-vendor when both enabled; single-vendor otherwise

quality:
  tier: balanced            # fast | balanced | thorough

clone_protocol: ssh         # ssh (default) | https
```

Full reference: [get-started.md](./get-started.md)

---

## Deployment

**Personal (`crosscheck watch`)** — runs on your laptop. An SSH tunnel through `localhost.run` handles GitHub webhook delivery automatically — no port-forwarding, no cloud account needed. Reconnects if the tunnel drops.

**Team (`crosscheck serve`)** — bind to a fixed port on a machine with a public IP or behind a reverse proxy. Register the webhook once; the whole team is covered without anyone's laptop staying on.

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
