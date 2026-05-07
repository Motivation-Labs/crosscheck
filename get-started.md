# crosscheck — Get Started

## Table of contents

- [Prerequisites](#prerequisites)
- [Install](#install)
- [Environment variables](#environment-variables)
- [Step 1 — Check your environment](#step-1--check-your-environment)
- [Step 2 — Test with a single PR](#step-2--test-with-a-single-pr)
- [Step 3 — Choose a deployment mode](#step-3--choose-a-deployment-mode)
- [Step 4 — Verify it's working](#step-4--verify-its-working)
- [Commands](#commands)
- [Configuration](#configuration)
- [How it works](#how-it-works)

---

## Prerequisites

You need three CLIs installed and authenticated before crosscheck can run reviews.

### Claude Code

```bash
npm install -g @anthropic-ai/claude-code
claude   # follow prompts to sign in to claude.ai
```

Requires a Claude Pro or Max plan. Reviews use your subscription quota — no per-token API billing.

### Codex

```bash
npm install -g @openai/codex
codex login --device-auth   # OAuth sign-in with your ChatGPT account
```

Requires a ChatGPT Plus or Pro plan. When authenticated via `--device-auth`, reviews run against your subscription — no API key needed.

If you prefer to use an OpenAI API key instead:

```bash
printenv OPENAI_API_KEY | codex login --with-api-key
```

Then set `auth: api-key` in your config to enable model selection.

### GitHub CLI

```bash
brew install gh       # macOS
gh auth login
```

Used for cloning PR branches and (in watch mode) registering webhooks automatically.

---

## Install

**Stable (recommended):**

```bash
npm install -g @motivation-labs/crosscheck
```

**Beta (latest features, may have rough edges):**

```bash
npm install -g @motivation-labs/crosscheck@beta
```

**npx — no install:**

```bash
npx @motivation-labs/crosscheck <command>
npx @motivation-labs/crosscheck@beta <command>
```

**From source:**

```bash
git clone https://github.com/Motivation-Labs/crosscheck
cd crosscheck
npm install && npm run build && npm link
```

---

## Environment variables

### GitHub auth — two options (pick one)

**Option 1 — gh CLI (recommended):** authenticate once and crosscheck picks up the token automatically:

```bash
gh auth login
```

**Option 2 — Personal access token:** useful in CI or if you prefer an explicit token:

```bash
export GITHUB_TOKEN=ghp_...
```

A classic PAT needs `repo` and `admin:org_hook` scopes (org-level webhooks require `admin:org_hook`; repo-level only needs `repo`).
Generate one at [github.com/settings/tokens](https://github.com/settings/tokens).

If both are present, crosscheck prefers the `gh` keyring token (always fresh) and uses `GITHUB_TOKEN` as a fallback.

### Webhook secret — auto-managed

`CROSSCHECK_WEBHOOK_SECRET` is **optional**. If you don't set it, crosscheck generates a random secret on first use and saves it to `~/.crosscheck/webhook-secret` (readable only by you). It's reused automatically on every subsequent run.

To retrieve it later (e.g. to register a webhook manually):

```bash
cat ~/.crosscheck/webhook-secret
```

To use your own secret instead, set it in your shell profile:

```bash
export CROSSCHECK_WEBHOOK_SECRET=your-secret
```

---

## Step 1 — Check your environment

```bash
crosscheck init
```

This scans your machine, reports the status of every dependency, and writes a starter `crosscheck.config.yml` to the current directory.

```
crosscheck — environment check

  ✓ codex CLI            codex-cli 0.128.0 — authenticated
  ✓ claude CLI           2.1.x (Claude Code)
  ✓ gh CLI               gh version 2.65.0
  ✓ GITHUB_TOKEN         set (gh auth login)
  ✓ WEBHOOK_SECRET       auto-managed at ~/.crosscheck/webhook-secret
```

Fix any failures before continuing.

---

## Step 2 — Test with a single PR

The fastest way to verify everything is working end-to-end:

```bash
crosscheck review https://github.com/owner/repo/pull/123 --reviewer codex
```

This clones the PR branch, runs Codex review against the base branch, and posts a comment to the PR. If it completes without error, your setup is working.

Try Claude as reviewer too:

```bash
crosscheck review https://github.com/owner/repo/pull/123 --reviewer claude
```

---

## Step 3 — Choose a deployment mode

### Watch mode — for your development machine

Starts a local server and opens a tunnel via `localhost.run` (SSH, no install needed) so GitHub can reach your laptop. Registers webhooks automatically. Supports org-level coverage or per-repo. Runs while your terminal is open.

```bash
# Monitor entire orgs (set in crosscheck.config.yml)
crosscheck watch

# Or run inside a repo — auto-detects from git remote
cd /path/to/your/repo && crosscheck watch
```

```
crosscheck watch

  orgs      motivation-labs, codatta
  mode      cross-vendor
  quality   balanced
  tunnel    https://abc123.lhr.life

Waiting for PR events — Ctrl+C to stop and clean up.
```

When you press `Ctrl+C`, the `gh webhook forward` processes are killed and webhooks are cleaned up automatically.

**Token scope for org webhooks:** `GITHUB_TOKEN` needs `write:org` scope for org-level coverage. For repo-level, `repo` scope is sufficient.

### Serve mode [BETA] — for an always-on machine (mac-mini, home server)

> **Beta:** `serve` is functional but not yet battle-tested in production. Report issues at [github.com/Motivation-Labs/crosscheck/issues](https://github.com/Motivation-Labs/crosscheck/issues).

Listens on a fixed port. You register the webhook(s) manually once and they stay registered.

```bash
crosscheck serve
```

```
crosscheck serving
⚠  serve is in beta — report issues at github.com/Motivation-Labs/crosscheck/issues

  mode      cross-vendor
  quality   balanced
  port      7891
  endpoint  http://your-machine.local:7891/webhook

Register the endpoint above as a GitHub org webhook (content-type: application/json).
  → https://github.com/organizations/motivation-labs/settings/hooks
  → https://github.com/organizations/codatta/settings/hooks
```

**For org-level coverage** (covers all repos in the org), register at:
`https://github.com/organizations/<org>/settings/hooks`

**For repo-level coverage**, register at:
`https://github.com/<owner>/<repo>/settings/hooks`

- Payload URL: `http://your-machine:7891/webhook`
- Content type: `application/json`
- Secret: your `CROSSCHECK_WEBHOOK_SECRET` value
- Which events: **Pull requests** only

**Running as a background service (macOS launchd):**

```xml
<!-- ~/Library/LaunchAgents/dev.crosscheck.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.crosscheck</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/crosscheck</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GITHUB_TOKEN</key><string>ghp_your_token</string>
    <key>CROSSCHECK_WEBHOOK_SECRET</key><string>your_secret</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/crosscheck.log</string>
  <key>StandardErrorPath</key><string>/tmp/crosscheck.error.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/dev.crosscheck.plist
launchctl start dev.crosscheck
```

**Running with pm2 (cross-platform):**

```bash
npm install -g pm2
pm2 start crosscheck -- serve
pm2 save && pm2 startup
```

---

## Step 4 — Verify it's working

Open a PR (or push to an existing one). You should see:

1. A log line in your terminal when the event arrives
2. A code review comment posted to the PR within ~60 seconds

If it doesn't appear, run `crosscheck status` to check auth and config, then check your GitHub webhook delivery log at `Settings → Webhooks → Recent Deliveries`.

---

## Commands

### `crosscheck init`

Checks your environment and writes a starter config file.

```bash
crosscheck init
crosscheck init --config /path/to/crosscheck.config.yml
```

What it checks: `codex` CLI, `claude` CLI, `gh` CLI, `GITHUB_TOKEN`, `CROSSCHECK_WEBHOOK_SECRET`.

| Flag | Description |
|---|---|
| `-c, --config <path>` | Write the config file to a specific path |

---

### `crosscheck review <pr-url>`

Manually triggers a review for a single PR.

```bash
crosscheck review https://github.com/owner/repo/pull/123
crosscheck review https://github.com/owner/repo/pull/123 --reviewer codex
crosscheck review https://github.com/owner/repo/pull/123 --reviewer claude
```

| Flag | Description |
|---|---|
| `-r, --reviewer codex\|claude` | Skip auto-detection and force a specific reviewer |
| `-c, --config <path>` | Use a specific config file |

---

### `crosscheck watch`

Local dev mode. Auto-creates a smee.io tunnel, registers the webhook, cleans up on exit.

```bash
cd /path/to/your/repo
crosscheck watch
```

Uses `localhost.run` (SSH) to open a public tunnel — SSH is pre-installed on macOS/Linux, no extra install or account needed. Requires `GITHUB_TOKEN` with `write:org` scope for org-level coverage, or `repo` scope for repo-level.

| Flag | Description |
|---|---|
| `-c, --config <path>` | Use a specific config file |

---

### `crosscheck serve` [BETA]

Always-on mode. Listens on a fixed port; you register webhooks once manually.

```bash
crosscheck serve
```

| Flag | Description |
|---|---|
| `-c, --config <path>` | Use a specific config file |

---

### `crosscheck status`

Shows auth state, config summary, and CLI versions.

```bash
crosscheck status
```

```
crosscheck status

  Auth
  ✓ codex                  authenticated
  ✓ claude                 2.1.x (Claude Code)
  ✓ GITHUB_TOKEN           set
  ✓ WEBHOOK_SECRET         set

  Config
    mode                   cross-vendor
    quality tier           balanced
    codex auth             subscription
    claude model           sonnet
    per-review budget      subscription (unlimited)

  CLIs
    codex                  codex-cli 0.128.0
    claude                 2.1.x (Claude Code)
```

| Flag | Description |
|---|---|
| `-c, --config <path>` | Check status against a specific config file |

---

### `crosscheck diagnose`

Reads `~/.crosscheck/logs/` and surfaces failure patterns, reviewer performance, and improvement suggestions.

```bash
crosscheck diagnose
crosscheck diagnose --since 2026-05-01
crosscheck diagnose --json
```

```
crosscheck diagnose

  Period   2026-05-07 → 2026-05-08  (1 log file)

  Reviews
    total       6
    successful  3
    failed      3  (50% failure rate)

  Reviewer performance
    codex    1/4 success  25%
    claude   2/2 success  100%

  Verdict distribution
    APPROVE     2  (67%)
    NEEDS WORK  1  (33%)
    BLOCK       0  (0%)

  Error patterns
    ✗ command not found: tsc                    ×2  (codex)
    ✗ base branch missing: staging              ×2

  Languages detected
    typescript, nodejs

  Suggestions
    → tsc: command not found ×2 (codex)
      add to instructions.md: "Do not run tsc, ts-node, or tsx."
    → base branch 'staging' not found ×2 — verify branch is fetched before review

  Run `crosscheck optimize` to apply suggestions automatically.
```

| Flag | Description |
|---|---|
| `--json` | Output full report as JSON (for scripting or piping to `optimize`) |
| `--since <YYYY-MM-DD>` | Limit analysis to logs from this date onward |

---

### `crosscheck optimize`

Runs `diagnose` internally, selects the best available AI agent, and generates an improved `~/.crosscheck/instructions.md`. Dry-run by default — shows a diff without writing.

```bash
crosscheck optimize             # show diff only
crosscheck optimize --apply     # apply the changes
crosscheck optimize --agent codex --apply
```

```
  Running diagnose...
  agent    claude  (default — both enabled, no data)

  diff  /Users/you/.crosscheck/instructions.md

  +## Constraints
  +
  +- Do not run tsc, ts-node, or tsx.
  +- Do not run npm, npx, yarn, or pnpm.
  ...

  Run with --apply to write changes to ~/.crosscheck/instructions.md
```

**Which agent does `optimize` use?**

`optimize` picks the agent automatically based on your config and log history:

1. If only one vendor is enabled → uses that one.
2. If both are enabled → uses whichever has the higher success rate in recent logs.
3. If rates are equal or no log data → defaults to `claude`.
4. `--agent claude|codex` overrides all of the above.

| Flag | Description |
|---|---|
| `--apply` | Write the improved instructions (default is dry-run) |
| `--dry-run` | Show diff without writing (default behavior, explicit alias) |
| `--agent <claude\|codex>` | Force a specific agent regardless of config or log data |
| `--since <YYYY-MM-DD>` | Limit the diagnose window used as input |
| `-c, --config <path>` | Config file path |

---

## Configuration

crosscheck looks for a config file in these locations (first found wins):

1. `./crosscheck.config.yml`
2. `./.crosscheck.yml`
3. `~/.crosscheck/config.yml`

Run `crosscheck init` to generate a starter file with all options commented.

### Full reference

```yaml
# ── Mode ──────────────────────────────────────────────────────────────────────
# single-vendor: one AI reviews all PRs
# cross-vendor:  Claude ↔ Codex review each other
mode: cross-vendor

# ── Vendors ───────────────────────────────────────────────────────────────────
vendors:
  codex:
    enabled: true
    auth: subscription      # subscription | api-key
    model: o4-mini          # only used when auth: api-key

  claude:
    enabled: true
    model: sonnet           # haiku | sonnet | opus
    effort: medium          # low | medium | high | max

# ── Quality ───────────────────────────────────────────────────────────────────
quality:
  tier: balanced            # fast | balanced | thorough
  focus:                    # narrows review scope (optional)
    - security
    - types
    - performance
  custom_prompt: |          # appended to every review prompt
    Be concise. Flag only issues that would block a merge.

# ── Budget ────────────────────────────────────────────────────────────────────
budget:
  codex_monthly_usd: 20     # null = unlimited; only applies when auth: api-key
  per_review_usd: 2.00      # passed to claude --max-budget-usd

# ── Orgs — covers all repos in each org with one webhook ─────────────────────
# Takes priority over `repos` when both are set.
orgs:
  - motivation-labs
  - codatta

# ── Repos — for monitoring specific repos only ────────────────────────────────
# Omit when using `orgs`. In watch mode, auto-detected from git remote if empty.
repos:
  - owner: acme
    name: specific-repo

# ── Routing ───────────────────────────────────────────────────────────────────
routing:
  codex_reviews_patterns:
    - "Generated with \\[Claude Code\\]"
  claude_reviews_patterns:
    - "Generated with \\[OpenAI Codex\\]"
    - "Co-Authored-By: codex"

# ── Server ────────────────────────────────────────────────────────────────────
server:
  port: 7891
  webhook_path: /webhook
```

### Quality tiers

| Tier | Speed | Depth | Best for |
|---|---|---|---|
| `fast` | ~10s | Top issues only | High-volume repos, draft PRs |
| `balanced` | ~30s | Full review, all issues explained | Default for most teams |
| `thorough` | ~60–90s | Deep multi-pass, architecture + security | Before merging to main |

### Routing patterns

Patterns are matched against the PR body as case-insensitive regular expressions.

- `codex_reviews_patterns` — PRs matching these are reviewed by Codex
- `claude_reviews_patterns` — PRs matching these are reviewed by Claude

To also review human PRs, add a catch-all:

```yaml
routing:
  codex_reviews_patterns:
    - "Generated with \\[Claude Code\\]"
    - ".*"    # Codex reviews all PRs
```

### Minimal config

```yaml
mode: cross-vendor
```

Everything else uses defaults.

---

## How it works

```
GitHub repo
    │  pull_request event (opened / synchronize)
    ▼
crosscheck webhook server
    │
    ├─ verify HMAC-SHA256 signature
    ├─ detect PR origin from body patterns
    ├─ assign reviewer (opposite vendor in cross-vendor mode)
    │
    ▼
clone PR branch into temp directory
    │
    ├─ codex review --base <branch>       ← non-interactive Codex review
    │  or
    └─ claude --print --bare ...          ← non-interactive Claude review
            │
            ▼
    post comment to PR via GitHub API
    delete temp clone
```

### PR origin detection

| Default pattern | Matches |
|---|---|
| `Generated with \[Claude Code\]` | PRs opened by Claude Code |
| `Generated with \[OpenAI Codex\]` | PRs opened by Codex CLI |
| `Co-Authored-By: codex` | Commits co-authored by Codex |

### Reviewer assignment

| Mode | PR origin | Reviewer |
|---|---|---|
| `cross-vendor` | claude | Codex |
| `cross-vendor` | codex | Claude |
| `cross-vendor` | human | None — skipped |
| `single-vendor` | any | First enabled vendor |

### How Codex reviews run

```bash
codex review --base <base-branch> --title "<pr-title>"
```

The `--base` flag diffs current HEAD against the base branch — exactly the PR diff. With `auth: subscription`, no model flag is passed. With `auth: api-key`, the model is selected by quality tier (`fast` → `gpt-4o-mini`, `balanced` → `o4-mini`, `thorough` → `o3`).

### How Claude reviews run

```bash
claude \
  --print --bare \
  --model claude-sonnet-4-6 \
  --effort medium \
  --max-budget-usd 2.00 \
  --output-last-message /tmp/review.md \
  --allowedTools "Bash(git diff),Bash(git log)" \
  "<prompt>"
```

`--bare` makes execution fast and deterministic. `--allowedTools` limits Claude to read-only git operations on the cloned repo.

### Deduplication

GitHub can fire both `opened` and `synchronize` events for the same push. crosscheck tracks `owner/repo#pr@sha` in an in-memory set and drops duplicate events for the same commit.

### Watch vs serve

| | `watch` | `serve` [BETA] |
|---|---|---|
| Tunnel | `localhost.run` via SSH (no install) | None — direct port |
| Webhook | Auto-managed, cleaned up on exit | Manual, permanent |
| Scope | Org-level or repo-level | Org-level or repo-level |
| Machine | Developer laptop | mac-mini / server |
| Lifecycle | Tied to terminal | Daemon / service |

### Security

- **Webhook signature** — every request verified with HMAC-SHA256 before parsing
- **Temp isolation** — each PR cloned into a fresh temp dir, deleted after review
- **Read-only tools** — Claude restricted to `git diff` and `git log` only
- **No credentials in clones** — `gh repo clone` uses the gh credential helper; no tokens written to disk

---

## FAQ

### How does crosscheck improve over time?

Every review — success or failure — is appended to `~/.crosscheck/logs/YYYY-MM-DD.ndjson`. Running `crosscheck diagnose` reads those logs and surfaces patterns: which commands failed, which reviewer is struggling, which language-specific tools were missing. Running `crosscheck optimize` feeds that report into your best-performing AI agent (guided by the bundled `AGENT.md`) and generates an improved `~/.crosscheck/instructions.md`. Both reviewers (claude and codex) read `instructions.md` before every review, so the improvements take effect immediately on the next PR.

### Which agent does `crosscheck optimize` use?

It picks automatically:
1. If only one vendor is enabled in your config → uses that one.
2. Both enabled → whichever has the higher success rate in recent logs.
3. Equal rates or no data → defaults to `claude`.
4. You can always override: `crosscheck optimize --agent codex`.

The agent used for `optimize` is independent of which agent reviews your PRs — `optimize` is about improving the instructions, not reviewing code.

### What is `~/.crosscheck/instructions.md` and can I edit it?

Yes — it is a plain Markdown file that both `codex` and `claude` read before every review. On first use, crosscheck seeds it with safe defaults (no build-tool constraints, a focused review prompt, and the VERDICT format). You can edit it manually at any time. `crosscheck optimize --apply` rewrites it, so keep a backup or use version control if you've made custom edits you want to preserve.

To reset to defaults, delete the file:
```bash
rm ~/.crosscheck/instructions.md
```
The next review will re-seed it from the built-in defaults.

### Can I have per-project instructions?

Yes. Create `.crosscheck/instructions.md` in your repo root. crosscheck checks for a project-level file first and uses it instead of the user-level one. This lets you enforce project-specific constraints (e.g. "this is a Rust project — do not suggest TypeScript patterns") without affecting other repos.

### What is `AGENT.md`?

`AGENT.md` is the harness document that guides the AI during `crosscheck optimize`. It defines the input/output contract, language-detection rules, constraint-writing guidelines, and quality principles. It ships bundled with crosscheck so `optimize` works out of the box.

You can override it by placing an `AGENT.md` at your project root or `.crosscheck/AGENT.md`. crosscheck checks for a local override first, then falls back to the bundled version. This lets teams customize the optimization logic for their specific stack or conventions.

### Why did my review fail with "command not found"?

The reviewer (codex or claude) tried to run a CLI tool (e.g. `tsc`, `pytest`) that isn't available in the temporary clone. The clone is a shallow `git` checkout with no `node_modules` or other installed dependencies. Run `crosscheck diagnose` to see which commands failed, then `crosscheck optimize --apply` to add the appropriate constraints to `instructions.md` so the reviewer stops trying.

### Why did my review fail with "no such branch"?

crosscheck fetches the PR base branch (e.g. `staging`) into the temp clone before running the reviewer. If that fetch fails (network issue, branch deleted, insufficient token scope), the reviewer cannot diff correctly. Check:
- The base branch exists and is accessible with your token.
- Your `GITHUB_TOKEN` has `repo` scope.
- The branch name in the PR matches what's on the remote.

### Does optimize run automatically?

No — `crosscheck optimize` is always user-triggered. You run it when you want to improve instructions. There is no background daemon or scheduled job. A future version may add an optional `--schedule` mode, but the default will always be manual to keep you in control of what gets written to `instructions.md`.
