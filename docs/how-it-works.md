# How It Works

## Overview

```
GitHub repo
    │  pull_request event (opened / synchronize)
    ▼
crosscheck webhook server
    │
    ├─ verify HMAC signature
    ├─ detect PR origin from body
    ├─ assign reviewer
    │
    ▼
clone PR branch (temp dir)
    │
    ├─ codex review --base <branch>     ← Codex non-interactive review
    │  or
    └─ claude --print --bare ...        ← Claude non-interactive review
            │
            ▼
    post comment to PR via GitHub API
    delete temp clone
```

---

## PR origin detection

crosscheck reads the PR body and matches it against regex patterns defined in `routing` config.

The default patterns match the attribution footers that Claude Code and Codex CLI add to PRs they open:

| Pattern | Matches |
|---|---|
| `Generated with \[Claude Code\]` | PRs opened by Claude Code |
| `Generated with \[OpenAI Codex\]` | PRs opened by Codex CLI |
| `Co-Authored-By: codex` | Commits co-authored by Codex |

If no pattern matches, the PR origin is classified as `human` and skipped in cross-vendor mode.

Detection is fully configurable — see [configuration.md](./configuration.md#routing) to add patterns, catch human PRs, or match custom footers.

---

## Reviewer assignment

| Mode | PR origin | Reviewer assigned |
|---|---|---|
| `cross-vendor` | `claude` | Codex |
| `cross-vendor` | `codex` | Claude |
| `cross-vendor` | `human` | None (skipped) |
| `single-vendor` | any | Whichever vendor is `enabled: true` |

---

## How Codex reviews run

crosscheck uses the `codex review` subcommand which runs non-interactively:

```bash
codex review --base <base-branch> --title "<pr-title>"
```

The `--base` flag tells Codex to review all changes between the current HEAD and the base branch — exactly the diff in the PR.

When `vendors.codex.auth: subscription`, no model flag is passed — the ChatGPT account determines the model. When `auth: api-key`, crosscheck selects the model based on the quality tier (`fast` → `gpt-4o-mini`, `balanced` → `o4-mini`, `thorough` → `o3`).

Custom focus instructions (from `quality.focus` and `quality.custom_prompt`) are written to `.codex/instructions` in the cloned repo before the review runs.

---

## How Claude reviews run

crosscheck calls the Claude Code CLI in print mode:

```bash
claude \
  --print \
  --bare \
  --model claude-sonnet-4-6 \
  --effort medium \
  --max-budget-usd 2.00 \
  --output-last-message /tmp/review.md \
  --allowedTools "Bash(git diff),Bash(git log)" \
  "<review prompt>"
```

- `--bare` strips hooks, auto-memory, and background processes — makes it fast and deterministic
- `--allowedTools` limits Claude to read-only git operations on the cloned repo
- `--max-budget-usd` caps spending per review (relevant when using API key auth)
- `--output-last-message` captures the final review text without parsing streamed output

---

## Deduplication

GitHub fires both `opened` and `synchronize` events for the same push in some cases. crosscheck deduplicates by tracking `owner/repo#pr@sha` in an in-memory set. If the same commit on the same PR is already being reviewed, subsequent events for that commit are dropped.

The dedup set is in-memory — it resets when the server restarts, which is the right behaviour (a restart after a crash should retry pending reviews).

---

## Watch vs serve mode

| | `watch` | `serve` |
|---|---|---|
| Tunnel | smee.io (auto-created) | None — direct port |
| Webhook registration | Automatic, deleted on exit | Manual, permanent |
| Intended machine | Developer laptop | mac-mini / home server / VPS |
| Lifecycle | Tied to terminal session | Runs as daemon / service |

---

## Security

**Webhook signature verification** — every incoming request is verified against the `CROSSCHECK_WEBHOOK_SECRET` using HMAC-SHA256. Requests with missing or invalid signatures are rejected with HTTP 401 before any payload is parsed.

**Temp directory isolation** — each PR is cloned into a fresh temporary directory and deleted immediately after the review completes, whether it succeeds or fails.

**Read-only Claude tools** — Claude is given access only to `Bash(git diff)` and `Bash(git log)` in the cloned repo. It cannot write files, run arbitrary commands, or access your working directory.

**No credentials in clones** — `gh repo clone` is used for cloning, which uses the `gh` credential helper. API keys and tokens are never written to the cloned repo or passed as environment variables to the reviewer processes.
