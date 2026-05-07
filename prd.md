# crosscheck — Product Requirements

## What This Is

crosscheck is a cross-vendor AI code review orchestrator. When Claude Code opens a PR, Codex reviews it. When Codex opens a PR, Claude reviews it. It runs locally using your existing AI subscriptions — no separate API billing required.

Published as `@motivation-labs/crosscheck` on npm.

---

## Goals

- **Use existing subscriptions** — run `claude` and `codex` CLIs locally, no per-token billing
- **Zero infrastructure** — one command on any machine with both CLIs installed
- **Config-as-code** — one flat YAML file, readable and writable by coding agents
- **Two deployment modes** — `watch` for laptops, `serve` for always-on machines
- **Org-level coverage** — one webhook covers all repos in an org

## Non-Goals

- Not a replacement for human code review
- Not a merge gate — posts comments, does not block PRs
- Not a hosted service — runs on your machine

---

## Current Status (v0.1.x)

### Shipped

- `crosscheck init` — environment check, auto-generates webhook secret, writes starter config
- `crosscheck review <pr-url>` — manual one-shot review with `--reviewer codex|claude`
- `crosscheck watch` — local dev mode with auto-smee tunnel and auto-webhook registration
- `crosscheck serve` [BETA] — always-on mode on a fixed port
- `crosscheck status` — shows auth state, config summary, CLI versions
- Cross-vendor mode (Claude ↔ Codex) and single-vendor mode
- Org-level and repo-level webhook support
- PR deduplication (owner/repo#pr@sha in-memory set)
- Auto-generated webhook secret persisted to `~/.crosscheck/webhook-secret`
- Published to npm as `@motivation-labs/crosscheck`
- CI: typecheck + build on Node 18/20/22 on every push
- CD: `@beta` on merge to main, `@latest` on `v*` tag (with production approval gate)

### Known Limitations

- `serve` mode is functional but not battle-tested in production
- Codex subscription auth does not support model selection (API key auth required for that)
- `--base` and prompt are mutually exclusive in `codex review`; focus instructions use `.codex/instructions` file

---

## Authentication

### npm publishing

npm no longer supports TOTP authenticator apps for 2FA. Interactive publish requires a passkey/security key. For terminal publishing, use a **granular access token** with publish permissions:

```bash
NPM_TOKEN=npm_xxx npm publish --access public
```

CI/CD uses `NPM_TOKEN` stored as a GitHub Actions secret — no interactive auth needed.

### GitHub token scopes

- `repo` — required for all commands
- `write:org` — required for org-level webhook registration in `watch`/`serve`
- Repo-level webhooks only need `repo`

---

## Build Queue

### 🔜 Next Up

- [ ] **Local debug log file** — persist structured runtime logs to `~/.crosscheck/logs/` for debugging. Enabled by default; configurable retention (default 7 days, max 30).
  - **User:** Anyone running `watch`/`serve` in production or debugging a failed review.
  - **Acceptance Criteria:**
    - Logs written to `~/.crosscheck/logs/YYYY-MM-DD.ndjson` (one file per UTC day, NDJSON format — one JSON object per line).
    - Events captured: `session_start`, `pr_received`, `review_started`, `review_complete`, `comment_posted`, `webhook_registered`, `webhook_deleted`, `tunnel_opened`, `error`.
    - Each entry has at minimum: `{ ts, level, event, ...contextFields }`.
    - Config keys `logs.enabled` (bool, default `true`) and `logs.retention_days` (int 1–30, default `7`) control behaviour.
    - When `logs.enabled: false`, no files are created or written.
    - On startup, files older than `retention_days` are deleted automatically.
    - `crosscheck status` shows log location and size of today's log file.
  - **Technical Notes:**
    - New file: `src/lib/logger.ts` — module-level singleton; exports `initLogger(config)` and `log(entry)`. `initLogger` runs retention cleanup and opens today's append stream. If `enabled: false`, all calls are no-ops.
    - Schema: add `LogsConfigSchema = z.object({ enabled: z.boolean().default(true), retention_days: z.number().int().min(1).max(30).default(7) })` to `schema.ts`; add `logs: LogsConfigSchema.default({})` to `ConfigSchema`.
    - `watch.ts` / `serve.ts`: call `initLogger(config)` near the top; augment the local `log()` closure to also call `logger.log(...)` for `info` events; wrap the PR handler catch block to call `logger.log({ level: 'error', event: 'error', ... })`.
    - `review.ts`: same — log `pr_received`, `review_started`, `review_complete`, `comment_posted`, `error`.
    - `status.ts`: add a `Logs` section showing path, enabled state, and today's file size if it exists.
    - Do NOT log review text content — only metadata (pr key, reviewer, verdict, duration, error messages). No secrets, no diffs.
  - **Tests Required:** `initLogger` with `enabled: false` writes nothing; retention cleanup deletes files older than N days and keeps newer ones; log entries are valid JSON; `review.ts` emits expected events.

- [x] **`GITHUB_TOKEN` false failure when `gh` is authenticated** — `crosscheck init` shows `✗ GITHUB_TOKEN missing` even when `gh auth login` was run and `gh CLI` passes. The `GITHUB_TOKEN` check is logically redundant when `gh` is already authenticated via stored credentials; the two checks test the same thing ("can we talk to GitHub?") via different paths.
  - **User:** Anyone running `crosscheck init` who authenticated via `gh auth login` rather than exporting `GITHUB_TOKEN`.
  - **Acceptance Criteria:**
    - If `gh auth status` reports "Logged in", the `GITHUB_TOKEN` row in `crosscheck init` should show ✓ (not ✗).
    - If neither `GITHUB_TOKEN`/`GH_TOKEN` env var nor `gh auth status` is authenticated, the row shows ✗ with the current fix hint.
    - At runtime (`watch`, `serve`, `review`), if `GITHUB_TOKEN` is unset but `gh` is authenticated, crosscheck derives the token via `gh auth token` and injects it before constructing the Octokit client — no manual export required.
  - **Technical Notes:**
    - `src/commands/init.ts` line 51: `GITHUB_TOKEN` check fires unconditionally. Gate it on `!ghAuthed` (reuse the `authed` bool already computed on line 43).
    - `src/config/loader.ts`: add a `resolveGithubToken()` helper that returns `process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? execSync('gh auth token').trim()` (catch on `execSync` failure).
    - `src/github/client.ts`: call `resolveGithubToken()` instead of reading the env var directly.
  - **Tests Required:** `gh authenticated + no GITHUB_TOKEN env` → init shows ✓; `gh not authenticated + no env` → shows ✗; `gh not authenticated + GITHUB_TOKEN set` → shows ✓.

- [x] **Fix `watch` mode tunnel** — replaced `gh webhook forward` (not available in gh 2.65.0) with `localhost.run` SSH tunnel. SSH is pre-installed on macOS/Linux, no account needed. Tunnel URL shown in watch banner; webhooks auto-registered and deleted on exit.
- [x] **Clean up `watch` output** — subprocess output no longer dumped raw; structured log lines only.
- [ ] **Test `serve` mode** — run on a fixed port, register webhook manually, verify reviews post correctly
- [ ] **`crosscheck review` result feedback** — after posting, log a link to the PR comment

- [x] **Live review progress + verdict** — ora spinners per stage (clone → review → post), VERDICT line in AI prompt, parsed and stripped before posting; verdict badge prepended to GitHub comment; color-coded in terminal.
- [x] **Fortune cookie welcome message** — random quote from `src/lib/fortune.ts` printed before watch/serve banner.

---

### Feature designs

#### Live review progress + verdict

**Problem:** once a PR event arrives, the terminal goes quiet for 30–90s while the AI runs. No feedback on what's happening or whether it passed.

**Solution — progress log:**

Use `ora` (already a dep) to show a spinner per stage, collapsing to a checkmark on success:

```
3:14:22 PM  PR #42 opened: fix: remove unused import
  ⠸ cloning motivation-labs/my-repo...
  ✓ cloned
  ⠸ codex reviewing...
  ✓ review complete
  ⠸ posting comment...
  ✓ posted → github.com/motivation-labs/my-repo/pull/42
  verdict  ✅ APPROVE
```

**Solution — verdict:**

Add a `## Verdict` section to the review prompt:

```
At the end of your review, add exactly this line:
VERDICT: APPROVE | NEEDS WORK | BLOCK

APPROVE    — no issues or trivial nits only
NEEDS WORK — addressable issues but not blocking
BLOCK      — security risk, data loss, broken API contract, or correctness bug
```

Parse the last `VERDICT:` line from the review text before posting. Display in the terminal with color (green / yellow / red). Strip the `VERDICT:` line before posting to GitHub so the comment stays clean — or keep it as a bold header at the top of the comment for visibility.

**Implementation files:** `src/reviewers/claude.ts`, `src/reviewers/codex.ts` (prompt addition), `src/commands/watch.ts` (progress spinner + verdict display), `src/commands/review.ts` (same for manual reviews).

---

#### Fortune cookie welcome message

**Problem:** startup feels cold and mechanical.

**Solution:** print one random quote before the watch/serve banner. Quotes are stored as a static array in `src/lib/fortune.ts` — no network call, no external dependency.

```
crosscheck  "The best code review is the one that ships."

crosscheck watch
  orgs    motivation-labs
  ...
```

Style: dim text, italic if the terminal supports it. One quote per startup, randomly selected. ~20 quotes in the initial set — mix of original lines about code review, AI, and shipping. No attribution needed (original quotes only, avoids copyright edge cases).

**Implementation files:** `src/lib/fortune.ts` (quote array + `randomFortune()` helper), `src/commands/watch.ts`, `src/commands/serve.ts` (call `randomFortune()` before the banner).

---

### 🔭 Backlog

- [ ] **Retry logic** — if `codex review` or `claude` subprocess fails, retry once with exponential backoff
- [ ] **`crosscheck logs`** — tail recent review activity from a local log file
- [ ] **Config validation on startup** — warn on unknown keys, required-but-missing fields
- [ ] **Per-repo routing overrides** — allow different quality tiers or reviewers per repo in config
- [ ] **Slack/email notification** — optional ping when a review is posted
- [ ] **Graduate `serve` out of beta** — battle-test on an always-on machine, document pm2/launchd setup

### ✅ Done

- [x] `init`, `review`, `watch`, `serve`, `status` commands
- [x] Cross-vendor and single-vendor modes
- [x] Org-level webhook support
- [x] Auto-generated webhook secret (`~/.crosscheck/webhook-secret`)
- [x] npm publish as `@motivation-labs/crosscheck`
- [x] CI (typecheck + build) + CD (staging @beta, production @latest) workflows
- [x] get-started.md — full documentation
- [x] `crosscheck init` gh CLI check accepts `GITHUB_TOKEN` env var as valid auth (no false failure when token is set but `gh auth login` was never run)
