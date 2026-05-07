# Getting Started

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

## Install crosscheck

**npm — recommended for permanent install:**

```bash
npm install -g crosscheck
```

**npx — no install, always latest:**

```bash
npx crosscheck <command>
```

**From source:**

```bash
git clone https://github.com/beingzy/crosscheck
cd crosscheck
npm install && npm run build && npm link
```

---

## Environment variables

Two variables are required at runtime. Add them to your shell profile (`~/.zshrc` or `~/.bashrc`):

```bash
# Required for all commands that touch GitHub
export GITHUB_TOKEN=ghp_...

# Required for serve and watch (must match the secret you set on the webhook)
export CROSSCHECK_WEBHOOK_SECRET=any-random-string
```

`GITHUB_TOKEN` needs `repo` and `pull-requests:write` scopes.
Generate one at [github.com/settings/tokens](https://github.com/settings/tokens).

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
  ✓ GITHUB_TOKEN         set
  ✗ WEBHOOK_SECRET       missing (only needed for serve/watch)
      → Set CROSSCHECK_WEBHOOK_SECRET
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

Starts a local server, creates a smee.io tunnel, and registers the webhook on your GitHub repo automatically. Runs while your terminal is open.

```bash
cd /path/to/your/repo
crosscheck watch
```

```
crosscheck watch

  repo      owner/repo
  mode      cross-vendor
  quality   balanced
  tunnel    https://smee.io/abc123xyz

Waiting for PR events — Ctrl+C to stop and clean up.
```

When you press `Ctrl+C`, the GitHub webhook is automatically deleted. No leftover hooks in your repo settings.

### Serve mode — for an always-on machine (mac-mini, home server)

Listens on a fixed port. You register the webhook manually once and it stays registered.

```bash
crosscheck serve
```

```
crosscheck serving

  mode      cross-vendor
  quality   balanced
  port      7891
  endpoint  http://your-machine.local:7891/webhook
```

Register the endpoint shown as a GitHub webhook at:
`https://github.com/owner/repo/settings/hooks`

- Payload URL: `http://your-machine:7891/webhook`
- Content type: `application/json`
- Secret: your `CROSSCHECK_WEBHOOK_SECRET` value
- Which events: **Pull requests** only

---

## Step 4 — Verify it's working

Open a PR (or push to an existing one). You should see:

1. A log line in your terminal when the event arrives
2. A code review comment posted to the PR within ~60 seconds

If it doesn't appear, run `crosscheck status` to check auth and config, then check your GitHub webhook delivery log at `Settings → Webhooks → Recent Deliveries`.
