# Commands

## `crosscheck init`

Checks your environment and writes a starter config file.

```bash
crosscheck init
crosscheck init --config /path/to/crosscheck.config.yml
```

**What it checks:**
- `codex` CLI — installed and authenticated
- `claude` CLI — installed and authenticated
- `gh` CLI — installed and authenticated
- `GITHUB_TOKEN` env var — set
- `CROSSCHECK_WEBHOOK_SECRET` env var — set

**What it writes:**
If no config file exists in the current directory, it copies `crosscheck.config.example.yml` as your starting point.

| Flag | Description |
|---|---|
| `-c, --config <path>` | Write the config file to a specific path |

---

## `crosscheck review`

Manually triggers a review for a single PR. Useful for testing your setup, re-reviewing after changes, or reviewing PRs that weren't caught automatically.

```bash
crosscheck review https://github.com/owner/repo/pull/123
```

**How it works:**
1. Fetches the PR metadata from GitHub
2. Detects origin (Claude / Codex / human) from the PR body
3. Assigns a reviewer based on mode and routing config
4. Clones the PR branch into a temp directory
5. Runs the reviewer CLI against the base branch diff
6. Posts the review as a comment to the PR
7. Deletes the temp clone

| Flag | Description |
|---|---|
| `-r, --reviewer codex\|claude` | Skip auto-detection and force a specific reviewer |
| `-c, --config <path>` | Use a specific config file |

**Examples:**

```bash
# Auto-detect reviewer from PR body
crosscheck review https://github.com/acme/backend/pull/42

# Force Codex to review regardless of PR origin
crosscheck review https://github.com/acme/backend/pull/42 --reviewer codex

# Force Claude to review
crosscheck review https://github.com/acme/backend/pull/42 --reviewer claude
```

---

## `crosscheck watch`

Local dev mode. Starts a webhook server, creates a smee.io tunnel, and registers the webhook on your repo automatically. Designed to run on your laptop while you're actively developing.

```bash
cd /path/to/your/repo
crosscheck watch
```

**What it does automatically:**
1. Detects your repo from `git remote origin`
2. Starts a local webhook server on `server.port` (default: 7891)
3. Creates a new smee.io channel (no account needed)
4. Registers that channel as a webhook on your GitHub repo
5. Starts the smee proxy to forward events to your local server
6. On `Ctrl+C`: deletes the webhook and shuts down cleanly

**Requirements:**
- `GITHUB_TOKEN` — needs `admin:repo_hook` scope to register/delete webhooks
- `CROSSCHECK_WEBHOOK_SECRET` — used to sign and verify webhook payloads

| Flag | Description |
|---|---|
| `-c, --config <path>` | Use a specific config file |

**Token scope note:** If webhook auto-registration fails (e.g. the token lacks `admin:repo_hook`), crosscheck falls back to printing the smee URL for manual registration. The review server still runs.

---

## `crosscheck serve`

Always-on mode for a dedicated machine (mac-mini, home server, VPS). Listens on a fixed port — you register the GitHub webhook once and it stays registered.

```bash
crosscheck serve
```

**Setup:**

1. Start the server:
   ```bash
   crosscheck serve
   ```

2. Register a GitHub webhook at `https://github.com/owner/repo/settings/hooks`:
   - Payload URL: `http://your-server:7891/webhook`
   - Content type: `application/json`
   - Secret: your `CROSSCHECK_WEBHOOK_SECRET` value
   - Events: **Pull requests** only

3. PRs now trigger reviews automatically whenever the server is running.

**Running as a background service (macOS launchd):**

```xml
<!-- ~/Library/LaunchAgents/dev.crosscheck.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.crosscheck</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/crosscheck</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GITHUB_TOKEN</key>
    <string>ghp_your_token</string>
    <key>CROSSCHECK_WEBHOOK_SECRET</key>
    <string>your_secret</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/crosscheck.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/crosscheck.error.log</string>
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
pm2 save
pm2 startup
```

| Flag | Description |
|---|---|
| `-c, --config <path>` | Use a specific config file |

---

## `crosscheck status`

Shows a snapshot of your current auth state, config, and CLI versions. Run this to diagnose why reviews aren't posting.

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
    repos                  acme/backend
    focus                  security, types

  CLIs
    codex                  codex-cli 0.128.0
    claude                 2.1.x (Claude Code)
```

| Flag | Description |
|---|---|
| `-c, --config <path>` | Check status against a specific config file |
