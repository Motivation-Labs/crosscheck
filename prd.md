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
- **Self-improving** — `diagnose` + `optimize` create a feedback loop from observed failures to better review instructions; crosscheck gets more useful the longer it runs

## Non-Goals

- Not a replacement for human code review
- Not a merge gate — posts comments, does not block PRs
- Not a hosted service — runs on your machine
- Not a one-size-fits-all reviewer — instructions should adapt to your stack and team conventions

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

- [ ] **`crosscheck diagnose`** — analyze `~/.crosscheck/logs/*.ndjson`, surface failure patterns and review quality signals as a human-readable report (with `--json` for machine output). This is the observability foundation that `optimize` and future tooling build on.
  - **User:** Anyone whose reviews are failing silently or who wants to understand what's working.
  - **Acceptance Criteria:**
    - `crosscheck diagnose` reads all log files in `~/.crosscheck/logs/`; accepts `--since YYYY-MM-DD` to limit range.
    - Groups `error` entries by pattern: `command_not_found` (which command, which reviewer), `base_branch_missing` (which branch), `timeout`, `auth_failure`, `other`.
    - Reports review outcome distribution: APPROVE / NEEDS WORK / BLOCK counts and percentages.
    - Reports per-reviewer success rate (attempts vs successes).
    - Reports repos and file types seen in reviewed PRs (for language detection in `optimize`).
    - Produces a `suggestions[]` array: each suggestion has `type` (`add_constraint`, `investigate`, `config_change`), a human-readable `reason`, and an optional `instruction` string ready to paste.
    - `--json` flag outputs the full structured report as JSON to stdout; default outputs a formatted terminal report.
    - Exit 0 always (it is a reporting tool, not a gate).
  - **Technical Notes:**
    - New file: `src/commands/diagnose.ts`.
    - Parser reads NDJSON line-by-line; tolerates malformed lines (skip + count).
    - Language detection: scan `repo` field in log entries; for each unique repo, check if a `package.json` / `tsconfig.json` / `requirements.txt` / `Cargo.toml` / `go.mod` / `pom.xml` exists in the clone tmpDir path logged with the entry (or fall back to heuristics from the PR diff path names).
    - Suggestion rules (seeded set — grows over time via AGENT.md improvements):
      - `command_not_found: tsc|npx|jest|vitest` → suggest adding "Do not run tsc / npm / jest." to instructions
      - `command_not_found: pytest|pip` → suggest Python constraint
      - `command_not_found: cargo` → suggest Rust constraint
      - `base_branch_missing` → flag as known infrastructure bug, link to fix
      - `timeout` → suggest increasing `timeout_ms` in config or reducing quality tier
    - Wire into `cli.ts` as `crosscheck diagnose [--json] [--since <date>]`.
  - **Tests Required:** parse a fixture NDJSON file with known errors → correct pattern counts; `--json` output is valid JSON matching schema; `--since` filters correctly; tolerates empty log dir.

- [ ] **`crosscheck optimize`** — run `diagnose` internally, select the best available local AI agent, feed the report into it using `AGENT.md` as the harness, diff the result against `~/.crosscheck/instructions.md`, and apply on `--apply`. Dry-run by default.
  - **User:** Anyone who wants crosscheck to adapt to their repos and fix recurring review failures without manual config editing.
  - **Agent selection — how optimize picks which AI to use:**
    The agent used to run `optimize` is chosen dynamically from the vendors already configured in `crosscheck.config.yml`, not hardcoded. This means optimize works regardless of whether the user has Claude, Codex, or both.

    Selection logic (`selectOptimizeAgent(config, diagnoseReport)`):
    1. Collect `enabled` vendors: those with `config.vendors[v].enabled === true`.
    2. If only one vendor is enabled → use it.
    3. If both are enabled → look at `diagnoseReport.reviewer_performance`: pick the vendor with the higher `successRate` (successes ÷ attempts) over the log period.
    4. If rates are equal or there is no log data → prefer `claude` (handles the long-form AGENT.md harness with higher fidelity).
    5. `--agent claude|codex` flag overrides all of the above.
    6. If no vendor is enabled or the selected vendor's CLI is not installed → exit 1 with a clear message naming the missing CLI.

    Examples:
    - Config has only `codex: enabled: true` → uses codex, no claude needed.
    - Config has both enabled; codex has 80% success rate vs claude's 50% → uses codex.
    - Config has both enabled; no log data → uses claude.
    - User passes `--agent codex` → uses codex regardless.

  - **Acceptance Criteria:**
    - `crosscheck optimize` (no flags) runs diagnose, selects the agent per the logic above, generates improved instructions, prints a unified diff of old vs new `instructions.md`, and exits without writing.
    - `crosscheck optimize --apply` writes the improved `~/.crosscheck/instructions.md`.
    - `crosscheck optimize --dry-run` is a synonym for the default no-flag behavior.
    - `crosscheck optimize --agent <claude|codex>` forces a specific agent.
    - Terminal output shows which agent was selected and why: `  agent  codex (success rate 80% > claude 50%)`.
    - On first run (no existing `instructions.md`), the diff shows the full new file as additions.
    - If `diagnose` finds no errors and no suggestions, optimize still runs and may refine wording; it never produces an empty instructions file (preserves at minimum the VERDICT format constraint).
    - Respects a project-level `AGENT.md` override at `{cwd}/AGENT.md` or `{cwd}/.crosscheck/AGENT.md`; falls back to the bundled `AGENT.md`.
  - **Technical Notes:**
    - New file: `src/commands/optimize.ts`.
    - `selectOptimizeAgent(config, report)` → `'claude' | 'codex'` — pure function, easy to test.
    - Agent invocation:
      - `claude`: `claude --print "<agentMd>\n\n<diagnoseJson>\n\nCurrent instructions.md:\n<current>"`
      - `codex`: `codex review` cannot be reused here; instead run `codex --print` (or equivalent non-interactive mode) with the same prompt. If codex does not support `--print`, fall back to the next available agent and log a warning.
    - AGENT.md lookup order: `{cwd}/AGENT.md` → `{cwd}/.crosscheck/AGENT.md` → `{packageRoot}/AGENT.md`.
    - Diff: small inline unified-diff helper (no new dependency).
    - Wire into `cli.ts` as `crosscheck optimize [--apply] [--dry-run] [--agent <claude|codex>] [--since <date>]`.
  - **Tests Required:** `selectOptimizeAgent` with only codex enabled → returns `'codex'`; with both enabled and codex higher success rate → returns `'codex'`; with both enabled and no log data → returns `'claude'`; `--agent` flag overrides; diff rendering shows +/- lines; AGENT.md lookup respects override order.

- [ ] **`AGENT.md` — bundled optimize harness** — ship a well-crafted `AGENT.md` at the repo root that guides claude during `optimize`. This file defines how to read diagnose output, detect languages, write good constraints, and stay within quality guardrails.
  - **User:** crosscheck itself (read by `optimize`); power users who want to fork and customize the optimization logic.
  - **Acceptance Criteria:**
    - `AGENT.md` exists at the project root and is included in the npm package (`files` in `package.json`).
    - Contains: purpose, input format spec, output format spec, language-detection mapping table, rules for good/bad instructions, VERDICT format preservation rule, reversibility rule (remove stale constraints), and worked examples.
    - Produces instructions that pass `npm run typecheck` after being applied (i.e., no instructions that break the `.codex/instructions` format).
    - Can be overridden by placing `AGENT.md` or `.crosscheck/AGENT.md` in the project root.
  - **Technical Notes:**
    - File is plain Markdown; no build step.
    - `optimize.ts` reads it at runtime via `fs.readFileSync` resolved from `import.meta.url` (package root).
    - Keep it under 400 lines — longer files reduce claude's instruction-following accuracy.

- [ ] **Adaptive instructions file** — both `codex.ts` and `claude.ts` read `~/.crosscheck/instructions.md` and append its content to the review prompt / `.codex/instructions`. Seeded with safe defaults on first run. Replaces the hardcoded `noBuildToolsNote` in `codex.ts`.
  - **User:** Anyone running `watch`/`serve` — they get out-of-box sane constraints and can improve them via `optimize`.
  - **Acceptance Criteria:**
    - `~/.crosscheck/instructions.md` is created on first review if it doesn't exist, seeded with the default no-build-tools constraint.
    - Project-level `.crosscheck/instructions.md` overrides the user-level file if present.
    - Both `codex.ts` and `claude.ts` append the instructions content; neither has hardcoded constraint strings.
    - If the file is empty or missing, reviews still work (graceful degradation).
    - `crosscheck status` shows the instructions file path and whether it exists.
  - **Technical Notes:**
    - New helper `src/lib/instructions.ts`: `readInstructions(repoDir?: string): string` — checks project-level then user-level; seeds default if neither exists; returns empty string on any read error.
    - Default seed content: the current `noBuildToolsNote` plus a header comment explaining the file is managed by `crosscheck optimize` but can be edited manually.
    - Remove `noBuildToolsNote` constant from `codex.ts`.

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

- [ ] **Tiered Feedback Loops — local usage analytics, instruction-effectiveness signals, and safe opt-in telemetry** — three-tier system that measures crosscheck's real-world impact, feeds those signals back into `optimize`, and—only with explicit consent—sends de-identified aggregate counts to inform future development. Privacy-first by design: sensitive data never leaves the machine; telemetry is opt-in (off by default).
  - **User:** All crosscheck users benefit from better defaults driven by real usage. Contributors to the project benefit from aggregate signal. Power users benefit from local analytics surfaced in `diagnose`.
  - **Acceptance Criteria:**

    **Tier 1 — Local count statistics (always-on, local only):**
    - After every review, append a metrics record to `~/.crosscheck/metrics/YYYY-MM.ndjson` containing: `{ ts, reviewer_pair, verdict, duration_ms, comments_count, pr_sha_prefix }`. `pr_sha_prefix` is the first 8 characters of the PR's head SHA — enough to detect follow-up commits later, not enough to identify the repo or author.
    - `reviewer_pair` values: `claude_reviews_codex`, `codex_reviews_claude`, `claude_reviews_claude`, `codex_reviews_codex`.
    - Follow-fix detection: when a new commit arrives on a PR that previously received a `NEEDS_WORK` or `BLOCK` verdict, log a `follow_fix` event linking the two reviews by `pr_sha_prefix`. This tracks whether AI review comments actually get addressed.
    - `crosscheck diagnose` incorporates Tier 1 data: adds a **Usage** section reporting reviewer-pair distribution, average comments per review, verdict distribution over the period, and follow-fix rate.
    - Metrics files are subject to the same `logs.retention_days` setting as event logs. Stored in `~/.crosscheck/metrics/`, never in the project directory.
    - No code content, no PR title, no repo name, no file names, no author identities stored.

    **Tier 2 — Instruction effectiveness tracking (always-on, local only):**
    - When `optimize` applies a new `instructions.md`, snapshot the current instruction fingerprint (SHA-256 of the file) and log it with a timestamp to `~/.crosscheck/metrics/optimize-history.ndjson`.
    - In subsequent metric records, include the active `instruction_fingerprint` so outcomes (verdict distribution, follow-fix rate) can be correlated with the instruction version in effect at review time.
    - `crosscheck diagnose --since <date>` can compare verdict distribution before and after each `optimize` run, surfacing the delta: "After optimize on 2025-05-01: APPROVE rate +12%, BLOCK rate −5%."
    - `crosscheck optimize` reads these deltas when selecting which instruction changes to keep vs. revert. If a fingerprint correlates with worse outcomes, `optimize` flags it as a candidate for rollback.
    - Instruction text is never stored — only the SHA-256 fingerprint. The actual text lives in `instructions.md` under the user's control.

    **Tier 3 — Privacy & consent design (non-negotiable constraints):**
    - Telemetry is **opt-in**. `telemetry.enabled` defaults to `false` in config. No data is transmitted unless the user explicitly enables it.
    - On first `watch`/`serve` run after install, display a one-time consent prompt:
      ```
        crosscheck can send anonymous usage counts to Motivation Labs to improve future versions.
        No code, no repo names, no PR content, no usernames — only aggregate numbers.
        Enable? [y/N]:
      ```
      Default answer is N. Response is persisted to `~/.crosscheck/config.yml` as `telemetry.enabled`. The prompt is never shown again. Users can change the setting at any time via `crosscheck telemetry [enable|disable|status]`.
    - `crosscheck init` output includes a **Telemetry** row: current state (enabled/disabled) and a link to the privacy doc.
    - Data categories that may **never** be collected or transmitted: code diffs, PR titles, PR descriptions, commit messages, file paths, repo names, GitHub usernames or org names, IP addresses, machine hostnames.
    - A `PRIVACY.md` at the repo root documents exactly which fields are in a telemetry payload. This document is referenced in the consent prompt and `get-started.md`.

    **Tier 4 — Safe telemetry payload (only when `telemetry.enabled: true`):**
    - `install_id`: a UUID generated once at first install and stored in `~/.crosscheck/config.yml`. Never linked to a GitHub identity, email, or hostname. Rotatable via `crosscheck telemetry reset-id`.
    - Transmission: weekly batch, sent at the start of the first `watch`/`serve` session of each UTC week. HTTPS POST to `https://telemetry.crosscheck.dev/v1/report` (TBD endpoint). No per-event streaming.
    - Payload schema (all fields are counts or enums — no free text, no identifiers):
      ```json
      {
        "install_id": "<uuid>",
        "version": "0.2.0",
        "platform": "darwin | linux | win32",
        "period": "2025-W20",
        "sessions": 12,
        "prs_reviewed": 47,
        "comments_posted": 134,
        "reviews_by_pair": {
          "claude_reviews_codex": 23,
          "codex_reviews_claude": 18,
          "claude_reviews_claude": 4,
          "codex_reviews_codex": 2
        },
        "verdict_distribution": { "APPROVE": 30, "NEEDS_WORK": 15, "BLOCK": 2 },
        "follow_fix_rate": 0.73,
        "optimize_runs": 2
      }
      ```
    - If the HTTP request fails (network error, server error), log locally and retry at the next weekly opportunity. Never block startup on telemetry.
    - `crosscheck telemetry status` shows: enabled/disabled, install_id (first 8 chars), date of last transmission, and the full payload that would be sent.
    - `crosscheck telemetry dry-run` prints the payload without sending it, regardless of `enabled` state. Useful for users who want to audit before enabling.

  - **Technical Notes:**
    - New file: `src/lib/metrics.ts` — `appendMetric(record)`, `readMetrics(since?)`, `computeSummary(records)`. Module-level singleton; respects `logs.enabled` (if logs are disabled, metrics are too). NDJSON append, same pattern as `logger.ts`.
    - New file: `src/lib/telemetry.ts` — `maybeSendTelemetry(config)`: checks enabled + weekly cadence (`~/.crosscheck/.telemetry-last-sent`), aggregates `metrics/` files, POSTs payload, updates sentinel. All errors are caught and logged locally; never throws to caller.
    - New file: `src/commands/telemetry.ts` — `crosscheck telemetry [enable|disable|status|dry-run|reset-id]`.
    - Schema additions: `telemetry: { enabled: boolean (default false), install_id: string (auto-generated) }`.
    - `watch.ts`/`serve.ts`: call `maybeSendTelemetry(config)` early in startup (after consent check on first run).
    - `review.ts`: call `appendMetric(...)` after each review completes (success or failure verdict).
    - `optimize.ts`: call `appendMetric({ event: 'optimize_run', fingerprint_before, fingerprint_after })` after applying changes.
    - `diagnose.ts`: extend output with Tier 1 usage summary section and Tier 2 instruction-effectiveness delta table.
    - `init.ts`: add Telemetry row to status table.
    - New file: `PRIVACY.md` at repo root, included in npm package. Documents full payload schema, data retention, opt-out instructions, and contact for data deletion requests.
  - **Tests Required:**
    - `appendMetric` with `logs.enabled: false` writes nothing.
    - Metrics records contain no sensitive fields (schema-level check on allowed keys).
    - `maybeSendTelemetry` with `enabled: false` makes no HTTP request.
    - `maybeSendTelemetry` within the same UTC week as last send makes no HTTP request.
    - `maybeSendTelemetry` in a new week POSTs the correct aggregated payload.
    - Consent prompt on first run persists response; not shown again on second run.
    - `telemetry dry-run` prints payload structure matching schema; makes no HTTP request.
    - `diagnose` with Tier 1 data shows reviewer-pair distribution and follow-fix rate.
    - `diagnose` with two instruction fingerprints shows before/after verdict delta.
    - Follow-fix event emitted when new commit arrives on a PR with prior `NEEDS_WORK`/`BLOCK` verdict.

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

#### Tiered Feedback Loops

**Problem:** crosscheck runs locally and has no visibility into whether it's actually helping. Without usage signal, `optimize` can only react to failures — it can't learn that certain reviewer configurations produce better outcomes, or that specific instruction patterns reliably increase fix-follow rates. At the same time, collecting that signal must not compromise user privacy or trust.

**Value:**
1. **Self-improvement with evidence** — `optimize` gains a before/after comparison of instruction changes vs. verdict distribution, so it can recommend keeping or reverting changes based on real outcomes rather than heuristics.
2. **Actionable `diagnose` output** — users learn which reviewer pair works best for their repos, what their follow-fix rate is, and whether recent `optimize` runs improved quality.
3. **Product signal for future development** — with explicit consent, anonymous aggregate counts answer questions like "what fraction of installs use cross-vendor mode?" without revealing anything about individual users or repos.
4. **Trust foundation** — a consent-first, audit-friendly design (dry-run, status, reset-id) makes telemetry a feature users can actually verify rather than a black box.

**Tier summary:**

| Tier | Data | Leaves machine? | Consent required? |
|---|---|---|---|
| 1 — Count statistics | Reviewer pair, verdict, duration, comment count, PR SHA prefix | Never | No |
| 2 — Instruction effectiveness | Instruction fingerprint (SHA-256 only), verdict delta | Never | No |
| 3 — Telemetry | Anonymous aggregate counts, install UUID, version, platform | Yes (if opted in) | Yes — opt-in |

**Privacy constraints (non-negotiable):**

These are design invariants, not config options:
- No code content ever stored or transmitted.
- No repo names, PR titles, file paths, GitHub usernames, org names, IP addresses, or hostnames.
- Telemetry payload contains only counts, enums, rates, and a locally generated UUID.
- The UUID is not derived from any user identity — it's a random v4 UUID generated at first install.
- Metrics files stay in `~/.crosscheck/metrics/` — never in the project directory where they could be accidentally committed.

**Consent flow (one-time, on first `watch`/`serve`):**

```
  crosscheck can send anonymous usage counts to Motivation Labs to improve
  future versions. No code, no repo names, no PR content, no usernames —
  only aggregate numbers. See PRIVACY.md for the exact payload.

  Enable telemetry? [y/N]:
```

Default: N. Response written to `~/.crosscheck/config.yml` immediately. Prompt is never shown again. Changeable any time:

```bash
crosscheck telemetry enable
crosscheck telemetry disable
crosscheck telemetry status       # shows state, last send date, install_id prefix
crosscheck telemetry dry-run      # prints payload without sending
crosscheck telemetry reset-id     # generates a new UUID, breaking any linkage
```

**Follow-fix detection (Tier 1):**

When a `synchronize` webhook fires on a PR that previously received a `NEEDS_WORK` or `BLOCK` verdict, log a `follow_fix` event linking the two review records by `pr_sha_prefix`. This event fires regardless of whether the new commit actually addresses the review — it's a count of "new activity after a non-APPROVE verdict." The ratio `follow_fix_events / NEEDS_WORK_or_BLOCK_reviews` is the follow-fix rate surfaced in `diagnose`.

**Instruction-effectiveness delta (`diagnose` output):**

```
Instruction history (last 30 days):
  fingerprint a1b2c3d4  active 2025-04-01 → 2025-05-01  (30 reviews)
    APPROVE 60%  NEEDS_WORK 33%  BLOCK 7%
  fingerprint e5f6a7b8  active 2025-05-01 → now          (17 reviews)
    APPROVE 76%  NEEDS_WORK 24%  BLOCK 0%   ↑ +16% APPROVE since last optimize
```

**Telemetry payload (full schema):**

```json
{
  "install_id": "<uuid-v4>",
  "version": "0.2.0",
  "platform": "darwin | linux | win32",
  "period": "2025-W20",
  "sessions": 12,
  "prs_reviewed": 47,
  "comments_posted": 134,
  "reviews_by_pair": {
    "claude_reviews_codex": 23,
    "codex_reviews_claude": 18,
    "claude_reviews_claude": 4,
    "codex_reviews_codex": 2
  },
  "verdict_distribution": { "APPROVE": 30, "NEEDS_WORK": 15, "BLOCK": 2 },
  "follow_fix_rate": 0.73,
  "optimize_runs": 2
}
```

No field may contain a string that could identify a user, repo, or machine. Any new telemetry field must be documented in `PRIVACY.md` before shipping.

**File layout additions:**

```
~/.crosscheck/
  metrics/
    YYYY-MM.ndjson          ← Tier 1 review events
    optimize-history.ndjson ← Tier 2 instruction fingerprints
  .telemetry-last-sent      ← ISO date of last successful transmission
src/
  lib/
    metrics.ts              ← appendMetric, readMetrics, computeSummary
    telemetry.ts            ← maybeSendTelemetry, aggregatePayload
  commands/
    telemetry.ts            ← crosscheck telemetry subcommands
PRIVACY.md                  ← exact payload schema, retention, opt-out, contact
```

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
