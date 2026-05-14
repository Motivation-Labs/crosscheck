# crosscheck — Product Requirements

## What This Is

crosscheck is an AI code review orchestrator. It monitors your GitHub repos and ensures every open PR that hasn't been reviewed yet gets a review from the right AI agent — automatically.

In **cross-vendor mode** (default): each PR is reviewed by the vendor that *didn't* write it (Claude reviews Codex PRs; Codex reviews Claude PRs). In **single-vendor mode**: every PR in scope gets reviewed by the one configured vendor. Either way, crosscheck handles detection, attribution, assignment, and posting — no manual coordination required.

It runs locally using your existing AI subscriptions — no separate API billing required.

Published as `@motivation-labs/crosscheck` on npm.

---

## Goals

- **Universal coverage** — every open PR in the monitored scope that lacks a crosscheck review is a candidate, regardless of whether the authoring agent can be identified
- **Use existing subscriptions** — run `claude` and `codex` CLIs locally, no per-token billing
- **Zero infrastructure** — one command on any machine with both CLIs installed
- **Config-as-code** — one flat YAML file, readable and writable by coding agents
- **Two deployment modes** — `watch` for laptops, `serve` for always-on machines
- **Org-level coverage** — one webhook covers all repos in an org
- **Self-improving** — `diagnose` + `optimize` create a feedback loop from observed failures to better review instructions; crosscheck gets more useful the longer it runs
- **Self-annotating** — each crosscheck action embeds machine-readable attribution metadata that makes future attribution more accurate, without relying on external conventions

## Non-Goals

- Not a replacement for human code review
- Not a merge gate — posts comments, does not block PRs
- Not a hosted service — runs on your machine
- Not a one-size-fits-all reviewer — instructions should adapt to your stack and team conventions

---

## Design Principles

These principles are authoritative. They override default assumptions when building new features or resolving ambiguous design decisions.

### P1 — Detection is attribution-agnostic

Whether to queue a PR for review is determined entirely by scope and review status — not by whether the authoring agent can be identified.

A PR is a review candidate if and only if:
1. Its author is in scope (`allowed_authors` if set, or any author in the monitored org/user/repo otherwise), AND
2. It has no existing crosscheck review comment.

`allowed_authors` is a **scope gate** (which authors crosscheck watches), not an attribution filter (who *wrote* the code). A PR from `beingzy` is in scope if `beingzy` is in `allowed_authors`, regardless of whether `beingzy` used Claude, Codex, or wrote the code by hand.

**Consequence**: attribution failure never silently drops a review. A PR that reaches the assignment step with unknown attribution is handled by the fallback policy, not silently skipped.

### P2 — Attribution determines assignment, not eligibility

Once a PR is queued (passes P1), attribution determines *which reviewer* is assigned. It does not re-gate whether a review happens.

**Attribution detection chain** — evaluated in order, stops at first match:
1. PR body — scan for configured `codex_reviews_patterns` / `claude_reviews_patterns`
2. Commit messages — same patterns applied to each commit message in the PR
3. Branch name prefix — `claude_branch_prefixes` / `codex_branch_prefixes`
4. PR comments — scan for crosscheck annotation tags (see P3); skipped if steps 1–3 resolved
5. `author_routes` — explicit `login → vendor` map in config
6. Fallback — apply `routing.fallback_reviewer` (default: `skip`)

**Assignment logic** given detected origin and config:

| Mode | Origin | Reviewer |
|---|---|---|
| cross-vendor | claude | codex (if enabled) |
| cross-vendor | codex | claude (if enabled) |
| cross-vendor | human / unknown | `routing.fallback_reviewer` (skip \| claude \| codex) |
| single-vendor | any | the one enabled vendor |

In single-vendor mode, attribution is still detected and logged (for analytics) — it just has no effect on assignment.

### P3 — Crosscheck annotates what it touches

Every action crosscheck takes embeds a machine-readable annotation so future runs can read attribution state without guessing.

**Annotation format** (these are stable — changing them is a breaking change):

| Action | Annotation location | Format |
|---|---|---|
| Review comment posted | End of comment body | `<!-- crosscheck: origin=claude reviewer=codex verdict=APPROVE -->` |
| Address commit pushed | Commit message trailer | `Crosscheck-Reviewer: codex` |

Detection step 4 (PR comments) scans for `<!-- crosscheck: origin=... -->` tags to recover attribution from a prior crosscheck review, even when the PR body and commit messages contain no patterns.

**Why this matters**: the first time crosscheck reviews a PR, attribution may be inferred from patterns. On follow-up events (new commits, recheck), the annotation provides a durable, precise attribution record — no re-inference needed.

### P4 — Agent behavior is governed by a harness system

Every time crosscheck invokes an AI agent — to review a PR, apply a fix, recheck after
changes, improve review instructions, or analyze logs — the agent's behavior is defined
by a **harness file**: a plain Markdown document that specifies what the agent receives,
what it must do, and what format it must output. No agent behavior is hardcoded in
TypeScript prompt strings. Logic lives in harness files.

---

#### The three-layer stack

```
workflow.yml          — declares steps and which harness section governs each
    ↓  cites
AGENT.md              — behavioral specification for all PR workflow steps
    ↓  produces
instructions.md       — persistent reviewer constraints, injected into every review call
```

At the bottom, `instructions.md` is what actually gets injected into `claude` and `codex`
during review. It is maintained automatically by `crosscheck optimize`, which reads
`AGENT.md` to know how to improve it.

---

#### Harness files

**`AGENT.md`** — the master behavioral guide, shipped with the package.

Has one section per workflow step. Each section is self-contained: it defines what data
the agent receives, what it must produce, and what constraints apply.

| Section | Used by | What it governs |
|---|---|---|
| `## optimize` | `crosscheck optimize` | How to read `diagnose` output and improve `instructions.md` |
| `## review` | `crosscheck review`, `crosscheck watch/serve` | How the reviewer agent should analyze a PR diff and produce a VERDICT |
| `## fix` | address step in `crosscheck run` | How the fixer agent should apply changes based on review findings |
| `## recheck` | recheck step in `crosscheck run` | How the re-reviewer should verify fixes and produce a final VERDICT |

`workflow.yml` steps cite a section by name (`harness: AGENT.md#review`). At runtime,
crosscheck reads the named section and prepends it to the agent invocation. The agent
receives: harness section + `instructions.md` constraints + PR diff/context.

**`ISSUE.md`** — specialized harness for `crosscheck issue --opportunities`.

Guides an agent to analyze `~/.crosscheck/logs/*.ndjson` for session stability, tunnel
reliability, and process health patterns — and draft a GitHub issue for the
highest-priority finding. Uses the same override chain as `AGENT.md`.

---

#### Override chain (identical for every harness)

```
{cwd}/<FILE>.md
{cwd}/.crosscheck/<FILE>.md
{packageRoot}/<FILE>.md     ← bundled fallback, always present after npm install
```

The first file found wins. Teams can ship a custom `AGENT.md` in their repo to override
review behavior for their stack without forking crosscheck.

---

#### How workflow.yml cites harnesses

```yaml
# .crosscheck/workflow.yml
steps:
  - type: review
    harness: AGENT.md#review          # injects ## review section into the reviewer agent
  - type: fix
    harness: AGENT.md#fix             # injects ## fix section into the fixer agent
    when: verdict != APPROVE
  - type: recheck
    harness: AGENT.md#review          # same review harness for consistency
    when: fix.applied == true
```

When `harness` is omitted from a step, crosscheck injects only `instructions.md` — the
current behavior. When `harness` is present, it prepends the named section before
`instructions.md`.

A project may supply a custom section by placing a local `AGENT.md` with a `## review`
override — crosscheck picks it up via the override chain automatically.

---

#### Rules for harness files

- Plain Markdown only — no code, no secrets, no runtime-generated content
- Keep each file under 400 lines — longer files reduce instruction-following fidelity
- Each section must define: (1) what data the agent receives, (2) what it must produce,
  (3) exact output format the TypeScript caller parses
- Output format changes are breaking — bump minor version and update the parser together
- Every harness file ships in `package.json` `files` so it is always present after `npm install`

#### Adding a harness for a new command

1. Add a `## <step-name>` section to `AGENT.md` (or create a new `<NAME>.md` for a
   distinct concern like `ISSUE.md`)
2. Add `load<Name>Harness(cwd)` using the three-path override chain
3. Add the file to `package.json` `files`
4. Update the harness table above

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

### 🚨 P0 — Structural correctness (fix before next routing/detection work)

These four items fix the two-phase model described in Design Principles. Any new feature that touches detection or routing depends on them being correct first.

- [ ] **Consolidate skip decision: delete `shouldReview()`, rely solely on `assignReviewer`** — `shouldReview` (detector.ts:82) and `assignReviewer` both independently gate on `origin === 'human'` in cross-vendor mode. Adding `fallback_reviewer` to only one of them creates a silent divergence. Full spec below.
  - **Acceptance Criteria:**
    - `shouldReview` is deleted from `detector.ts` and from all exports.
    - Call sites in `serve.ts`, `watch.ts`, and `review.ts` that check `shouldReview(...)` are replaced with `assignReviewer(...) !== null`.
    - Behavior for all existing origin values is unchanged.
    - No type error or lint warning from the removed export.
  - **Technical Notes:** call sites pass `origin` and `config` to `shouldReview`; the equivalent is `assignReviewer(origin, config) !== null`. Both code paths already have `reviewer` from `assignReviewer` in scope — no new variable needed.
  - **Tests Required:** `shouldReview` not exported; serve/watch/review behavior unchanged for `origin: 'claude'`, `'codex'`, `'human'`.

- [ ] **`routing.fallback_reviewer` config field (P2 assignment)** — full spec in Next Up.

- [ ] **Comment-based attribution detection (P2 step 4)** — full spec in Next Up.

- [ ] **Crosscheck annotation system (P3)** — full spec in Next Up.

- [x] **`crosscheck onboard` destroys existing config customizations on re-run** — fixed in PR #74. All write logic extracted into `applyOnboardConfig`; routing.* fields now initialised on first run only and preserved exactly on re-runs; workflow.yml only written when it doesn't already exist and only deleted when the pipeline explicitly changes away from recheck.

- [ ] **review → fix → re-check loop is not implemented** — `crosscheck onboard` lets users select the `review-fix-recheck` pipeline and writes `~/.crosscheck/workflow.yml`, but no execution engine reads or runs that file during `watch`/`serve`. The `post_review.auto_fix` config drives a single fix pass; there is no loop that re-reviews after the fix to confirm issues are resolved.
  - **User:** Anyone who selected `review → fix → re-check` during onboard and expects a full loop.
  - **Acceptance Criteria:**
    - `loadWorkflow()` in `src/lib/workflow.ts` resolves `workflow.yml` via the override chain: `{cwd}/.crosscheck/workflow.yml` → `~/.crosscheck/workflow.yml` → built-in default.
    - For a three-step workflow (review → fix → recheck): after the fix step completes and `fix.applied_count > 0`, the recheck step runs the reviewer again on the updated branch.
    - Verdict from the recheck step is posted as a follow-up comment on the original PR.
    - If no fix was applied (reviewer approved or fixer found nothing to change), the recheck step is skipped.
    - **One loop by default:** after the recheck step posts its verdict, crosscheck stops. No further automated fix or recheck is triggered regardless of verdict. All follow-up after recheck is manual.
    - `max_rounds` is configurable — in `crosscheck.config.yml` under `post_review.auto_fix.max_rounds` (integer, default: `1`) and as `--max-rounds <n>` on `ck review` and `ck run`. This lets power users opt into more passes while keeping the safe default.
    - The recheck step is always terminal — the runner must not enqueue another fix step after recheck regardless of `max_rounds`. `max_rounds` controls how many review→fix iterations run before the final recheck, not how many rechecks run.
    - Schema: `post_review.auto_fix.max_rounds` is a positive integer, minimum 1. Values below 1 are rejected at config load time with a clear error.
  - **Technical Notes:** `src/lib/workflow.ts` has the schema and `loadWorkflow()` but the step execution logic in `watch.ts`/`serve.ts` only runs a single review pass. The fix step (`post_review.auto_fix`) is partially implemented but the recheck step after fix is missing. The `workflow.yml` `when:` condition (`fix.applied_count > 0`) requires a step-result context object to be threaded through the execution loop. Add `max_rounds` to `schema.ts` with `z.number().int().min(1).default(1)`; thread it through `runWorkflow()` opts; add `--max-rounds` to `cli.ts` for both `review` and `run` commands.
  - **Observed bug (Motivation-Labs/motivation-money#229, 2026-05-13):** PR looped through recheck → fix → recheck multiple times, generating 4+ automated comments. Root cause: the recheck step triggered a new webhook event (new commit pushed by the fixer), which was not recognised as a crosscheck-owned commit and re-entered the full pipeline. Fix requires both the `max_rounds` cap and reliable crosscheck-commit filtering (see "crosscheck-commit filter" item below).
  - **Tests Required:** mock workflow with review → fix → recheck; assert recheck fires only when `fix.applied_count > 0`; assert pipeline halts after recheck regardless of recheck verdict; assert `max_rounds: 2` runs two review→fix iterations then one recheck; assert `max_rounds: 0` is rejected at config load; assert `--max-rounds 2` on `ck review` overrides config value; assert a push from a `[crosscheck]`-prefixed commit does not re-enter the pipeline.

- [ ] **crosscheck-commit filter must be durable across sessions** — the current in-memory `crosscheckShas` set (runner.ts) breaks across process restarts and separate `serve`/`watch` invocations. When a fix commit lands on a branch and the process has restarted (or a new webhook delivery arrives after a cold start), the SHA is no longer in the set and crosscheck re-enters the full pipeline, causing the recheck → fix → recheck loop observed in motivation-money#229.
  - **User:** Anyone running `serve` or `watch` in a long-lived process or with restarts.
  - **Acceptance Criteria:**
    - Commit message prefix `[crosscheck]` is checked in the webhook handler **before** dispatching to `onPR` — no process state required.
    - The webhook handler (`webhook.ts:76`) already only acts on `pull_request` events with action `opened` or `synchronize` — raw `push` events are never dispatched. The filter must therefore target the `synchronize` path: before calling `onPR`, fetch the head commit message of the PR and skip if it starts with `[crosscheck]`.
    - The in-memory `crosscheckShas` set is kept as a secondary fast-path but is not the sole guard.
  - **Technical Notes:** `src/github/webhook.ts:76` dispatches `onPR` for `opened | synchronize`. For `synchronize` events, `body.pull_request.head.sha` is available — use it to fetch the commit message via the GitHub API (or pass it through `PREvent`) and short-circuit before `onPR` if the message starts with `[crosscheck]`. The `[crosscheck]` prefix is already used in all fix commit messages (`runner.ts:217,236`).
  - **Tests Required:** webhook handler receives `synchronize` event where head commit message starts with `[crosscheck]` → `onPR` is not called; webhook handler receives `synchronize` event with normal commit → `onPR` is called; webhook handler receives `opened` event with `[crosscheck]` commit → `onPR` is called (opened events are never crosscheck-originated).

---

### 🔜 Next Up

- [x] **Onboard — workflow, mode, and pipeline steps** — extend `crosscheck onboard` with interactive steps for review mode (cross-vendor vs single-vendor) and workflow pipeline (review-only, review→fix, review→fix→re-check). Mode step is shown only when both AI CLIs are authenticated; pipeline step always shown.
  - **User:** Anyone running `crosscheck onboard` for the first time, or re-running after installing a second AI CLI.
  - **Acceptance Criteria:**
    - `checkEnv()` now returns `{ ok, claudeOk, codexOk }` so downstream steps know which CLIs are available.
    - **Step 4 — review mode:** shown when both claude and codex are authenticated.
      - `[1] cross-vendor` (default) → `mode: cross-vendor`, both vendors enabled.
      - `[2] single-vendor` → asks which vendor; disables the other in `vendors.*.enabled`.
      - When only one CLI is available, step auto-selects single-vendor and skips the prompt.
      - `--yes` keeps the existing mode from config without prompting.
    - **Step 5 — workflow pipeline:**
      - `[1] review only` → `post_review.auto_fix.enabled: false`.
      - `[2] review → fix` (recommended default) → `auto_fix.enabled: true, trigger: on_issues, delivery.mode: commit`.
      - `[3] review → fix → re-check` → same as fix, plus writes `~/.crosscheck/workflow.yml` with a three-step pipeline (review, fix, recheck).
      - `--yes` preserves existing auto_fix.enabled setting.
    - Step 6 (was 4) summary shows `mode` and `pipeline` rows in addition to existing fields.
    - `loadWorkflow()` checks `~/.crosscheck/workflow.yml` as a global fallback (after project-local `.crosscheck/workflow.yml`, before `DEFAULT_WORKFLOW`).
  - **Technical Notes:**
    - `src/commands/onboard.ts`: `checkEnv()` returns `EnvCheckResult`; new helpers `promptVendorMode()` and `promptWorkflowPipeline()`; config write also patches `mode`, `vendors.*.enabled`, `post_review.auto_fix.*`.
    - `src/lib/workflow.ts`: `loadWorkflow` candidates array extended with `join(homedir(), '.crosscheck', 'workflow.yml')`.
    - Global workflow.yml only written for the `review-fix-recheck` preset; `review-only` and `review-fix` are handled entirely through config fields.
  - **Related items:** Custom Workflow Engine (workflow.yml schema), Post-Review Auto-Fix (auto_fix config), Deployment Mode (patchDeploymentConfig pattern). The global workflow.yml fallback unblocks the full review→fix→recheck loop for users who don't have a per-project workflow file.

- [ ] **`~/.crosscheck/workflow.yml` written for every pipeline preset; per-step instructions inline** — `workflow.yml` is the single source of truth for both the pipeline topology and the per-step reviewer instructions. Currently it is only written for the `review-fix-recheck` preset; `review-only` and `review-fix` encode their configuration in `post_review.auto_fix.*` config fields instead. This split means users cannot find or edit their pipeline in one place, and `crosscheck optimize` has no structured location to write per-step instructions (it falls back to a monolithic `instructions.md`).
  - **User:** Anyone running `crosscheck onboard` who wants to understand, inspect, and customize how their reviews run.
  - **Design decision:** Per-step instructions live inline in `workflow.yml` (not in separate files). The existing `instructions: string` field per step already supports this. A single file to back up, a single file to hand to `crosscheck optimize`.
  - **Acceptance Criteria:**
    - `crosscheck onboard` always writes `~/.crosscheck/workflow.yml` regardless of which pipeline preset is selected.
    - Three preset templates, each with per-step inline instructions:

      **review-only:**
      ```yaml
      # crosscheck workflow — generated by crosscheck onboard
      on: [opened, synchronize]
      steps:
        - name: review
          type: review
          reviewer: auto
          max_rounds: 1
          instructions: |
            ## Constraints
            - Do not run tsc, ts-node, or build commands — inspect source files directly.
            - Do not install packages or modify lock files.
            ## Output format
            Structure your output as: ## Summary, ## Critical Issues, ## Warnings, ## Suggestions.
            Be concise. Skip praise.
            ## Verdict
            End with one of: VERDICT: APPROVE | NEEDS WORK | BLOCK
      ```

      **review-fix:** same as review-only, plus:
      ```yaml
        - name: fix
          type: fix
          reviewer: origin
          when: "review.verdict != 'APPROVE'"
          max_rounds: 1
          instructions: |
            Only fix issues explicitly called out in the review.
            Do not refactor unrelated code, rename variables, or add tests unless specifically requested.
            If a comment requires deeper understanding of business logic, skip it.
      ```

      **review-fix-recheck:** same as review-fix, plus:
      ```yaml
        - name: recheck
          type: recheck
          reviewer: auto
          when: "fix.applied_count > 0"
          max_rounds: 1
          instructions: |
            This is a follow-up review after automated fixes were applied.
            Focus on whether the flagged issues from the original review have been resolved.
            Use the same verdict scale: APPROVE if all critical issues are addressed, NEEDS WORK if some remain, BLOCK if regressions were introduced.
      ```

    - `applyOnboardConfig` writes the correct template to `~/.crosscheck/workflow.yml` for the selected preset. If the file already exists, it is **not overwritten** (same rule as before — the user may have customized it).
    - `loadWorkflow` precedence is unchanged: `.crosscheck/workflow.yml` in project root → `~/.crosscheck/workflow.yml` → `DEFAULT_WORKFLOW` (built-in constant, last resort only).
    - `DEFAULT_WORKFLOW` remains in code as a fallback for environments where onboard was never run. Its inline instructions remain the same defaults that get written into the onboard-generated templates.
    - `post_review.auto_fix.*` fields in `config.yml` continue to be written by onboard for backward compatibility with older `watch`/`serve` code that reads them directly. This duplication is intentional during the transition period while the workflow engine implementation is pending.
    - `crosscheck optimize --apply` updates the `instructions` fields of individual steps within `~/.crosscheck/workflow.yml` using targeted YAML mutations (load → mutate step's `instructions` field → dump). It no longer writes to `~/.crosscheck/instructions.md`. Existing `instructions.md` files are left in place for users who created them manually.
  - **Technical Notes:**
    - `src/commands/onboard.ts` (`applyOnboardConfig`): replace the three-branch workflow.yml write with per-preset YAML templates that include inline instructions. Use `WORKFLOW_TEMPLATES` constant keyed by `WorkflowPreset`.
    - `src/lib/workflow.ts` (`DEFAULT_WORKFLOW`): keep as-is. The templates written by onboard are generated from this same content so they stay in sync.
    - `src/commands/optimize.ts`: replace `writeFileSync(instructionsPath, ...)` with a targeted mutation of `workflow.yml` — load raw YAML, find the step by name, set `instructions`, dump. Falls back to writing `instructions.md` if `workflow.yml` doesn't exist.
    - Schema (`WorkflowStepSchema`): no change needed — `instructions: z.string().optional()` already supports inline text.
  - **Tests Required:**
    - `applyOnboardConfig` with `review-only` → `workflow.yml` written with one step and correct inline instructions.
    - `applyOnboardConfig` with `review-fix` → two steps.
    - `applyOnboardConfig` with `review-fix-recheck` → three steps.
    - Re-run with same preset when file exists → file unchanged.
    - `loadWorkflow` reads inline `instructions` from file and returns them on the step objects.

- [ ] **`~/.crosscheck/` as the persistent customization home — document all files and their roles** — crosscheck accumulates customization across multiple commands (`onboard`, `optimize`, manual edits). Today these relationships are implicit. Formalise the full file map in docs and in `crosscheck status` output so users know exactly what they have configured and how it is consumed.
  - **User:** Anyone who wants to understand what crosscheck has remembered, back it up, or restore it after a reinstall.
  - **Acceptance Criteria:**
    - `get-started.md` has a dedicated "Customization home" section that lists every file in `~/.crosscheck/`, what writes it, what reads it, and which fields are owned vs user-managed.
    - `README.md` has a brief "Customization files" table linking to the full section.
    - `crosscheck status` output includes a "files" row listing which customization files exist (✓ present / — absent): `config.yml`, `workflow.yml`, `instructions.md`, `webhook-secret`, `logs/`.
    - The complete file map (canonical reference):

      | File | Written by | Read by | Purpose |
      |---|---|---|---|
      | `~/.crosscheck/config.yml` | `onboard`, `init`, `watch` (first run) | all commands | Main config — deployment, repos, mode, vendors, quality, tunnel, routing, budget, branding |
      | `~/.crosscheck/workflow.yml` | `onboard` (recheck preset only) | `watch`, `serve`, `run` | Global pipeline steps override — written once, never overwritten unless explicitly changed |
      | `~/.crosscheck/instructions.md` | `optimize --apply` | `watch`, `serve`, `run` (injected into every review prompt) | Learned reviewer constraints — grows over time via optimize |
      | `~/.crosscheck/webhook-secret` | `init`, `watch` (auto-generated) | `watch`, `serve` | HMAC secret for GitHub webhook signature verification |
      | `~/.crosscheck/logs/YYYY-MM-DD.ndjson` | `watch`, `serve` | `diagnose`, `optimize`, `impact`, `issue` | Structured review event log — one file per day, 7-day retention |
      | `.crosscheck/workflow.yml` *(in repo)* | manual | `watch`, `serve`, `run` | Per-project pipeline override — takes priority over global |
      | `.crosscheck/AGENT.md` *(in repo)* | manual | `optimize` | Per-project harness override — takes priority over bundled |
      | `AGENT.md` *(bundled)* | npm package | `optimize` | Default harness — defines how `optimize` builds reviewer instructions |

    - Ownership rules (enforced by `applyOnboardConfig`):
      - `onboard` owns: `deployment`, `orgs`, `repos`, `mode`, `vendors.*.enabled/effort`, `quality.tier`, `tunnel.*`, `post_review.auto_fix.*`
      - `onboard` initialises on first run only: `routing.*` (never overwritten on re-runs)
      - `onboard` never touches: `quality.focus`, `quality.custom_prompt`, `budget.*`, `branding.*`, `server.*`, `logs.*`, `backtrace.*`, `instructions.md`, harness files
  - **Technical Notes:** `crosscheck status` already reads config; extend it to check for the existence of each `~/.crosscheck/` file and print a summary row. No schema changes needed.
  - **Tests Required:** status output includes files row; each file shows correct ✓/— based on filesystem state.

- [ ] **Smart onboard re-run — "last choice" indicators and instant re-confirm** — re-running `crosscheck onboard` after a reinstall or on a new machine should feel instant. Since `~/.crosscheck/config.yml` persists, every picker can pre-select the previous answer and mark it visually, letting the user press Enter through all steps to confirm without re-reading every option.
  - **User:** Anyone re-running onboard after `npm install -g @motivation-labs/crosscheck` (upgrade or fresh machine with backed-up `~/.crosscheck/`).
  - **Acceptance Criteria:**
    - Each `promptSinglePicker` step pre-selects the value from the existing config (already done via `defaultIndex`).
    - The pre-selected item shows a `(current)` suffix appended to its description line so users can visually confirm they are accepting the previous value, not a random default.
    - A one-line dim header appears at the top of `crosscheck onboard` when a config is detected: `Resuming from ~/.crosscheck/config.yml — press Enter to keep each setting.`
    - `crosscheck onboard --yes` is the fully silent re-confirm path: reads config, applies all previous values, writes config, exits. Zero prompts. Suitable for scripted reinstalls.
    - Repo picker pre-selects repos from `config.repos` + orgs from `config.orgs` (already done via `initialSelected`).
  - **Technical Notes:** The description suffix `(current)` is appended in-place in `promptVendorMode`, `promptQualityTier`, `promptWorkflowPipeline`, `promptConnectionType` when the item matches the existing config value. No change to `promptSinglePicker` signature needed — use the `description` field.
  - **Tests Required:** When existing config has `quality.tier: thorough`, the `thorough` item's description includes `(current)`. When no config exists, no `(current)` suffix appears on any item.

- [x] **Per-PR status bar — live step states + workflow-aware Fix/Recheck visibility** — the active PR slot's second line (`PR | CR | Fix`) does not accurately reflect real-time step state: CR shows `pending` even while a review is actively running, Fix and Recheck are always rendered as `pending` regardless of whether the workflow is configured to run them, and the per-PR section disappears from the board after completion.
  - **User:** Anyone running `crosscheck watch` or `crosscheck serve` who monitors the terminal during active reviews.
  - **Problem (observed in screenshot):** While codex is reviewing PR #78, the status bar shows `CR [░░░] pending | Fix [░░░] pending`. Two issues: (1) CR should show an active/in-progress state (e.g. a spinner or `reviewing…` label) rather than `pending` — `pending` implies the step hasn't started; (2) Fix (and Recheck, for review-fix-recheck workflows) should respect the loaded `workflow.yml` — if the step is not in the workflow, the column should show `—` or be omitted rather than implying it is queued. If the step is in the workflow but waiting for the prior step to finish, it should show `queued`; if it ran, it should show its outcome.
  - **Acceptance Criteria:**
    - **CR step state transitions (active slot):**
      - `queued` — PR arrived, review has not started yet (brief gap between event receipt and reviewer launch).
      - `⠋ reviewing…` (spinner) — reviewer CLI is actively running.
      - `✓ APPROVE` / `⚠ NEEDS WORK` / `✗ BLOCK` — review completed; colored badge.
      - `✗ error` — reviewer exited non-zero.
    - **Fix step state (workflow-aware):**
      - Not in workflow → column shows `Fix —` (dash, no bar). Column width and separator preserved so layout doesn't shift.
      - In workflow, waiting for CR to finish → `Fix queued`.
      - In workflow, running → `Fix ⠋ applying…`.
      - In workflow, completed → `Fix ✓ N applied` or `Fix — skipped` (when verdict was APPROVE and `when` condition was false).
      - In workflow, errored → `Fix ✗ error`.
    - **Recheck step state** — same state machine as Fix, using the same column rules. Shown as a fourth column `| Recheck …` when present in workflow; absent (not even `—`) when not in workflow.
    - **Per-PR section persists after completion** — after `completePR()` is called, the two-line entry is printed to scrollback (as it is today) AND a "completed" version of the slot remains visible in the live board area until the next render cycle clears it naturally (or for at least 5 seconds). This gives the user a moment to see the final verdict before the slot disappears.
    - The three columns always align; column widths do not change between state transitions (use fixed-width labels).
  - **Technical Notes:**
    - `src/lib/board.ts` (`renderPRSlot()`): add a `phase` field to `PRSlot` to distinguish `queued | reviewing | reviewed | fixing | fixed | rechecking | rechecked | error`. Drive the CR/Fix/Recheck labels from `phase` rather than checking `slot.verdict === undefined`.
    - `src/commands/watch.ts` (or wherever `updatePR()` is called): emit a `phase` update at each step transition — before launching the reviewer CLI, after it exits, before launching the fixer, after it exits.
    - Load the active workflow steps at board-init time (via `loadWorkflow()`); pass the step names to `PRBoard` so it knows which columns to render.
    - For the 5-second completed-slot retention: set a `completedAt` timestamp on the slot in `completePR()`; `render()` includes recently-completed slots (within the retention window) in the live block, rendered with a dim ✓ prefix on line 1 and frozen final state on line 2.
  - **Tests Required:**
    - `renderPRSlot()` with `phase: 'reviewing'` renders `⠋ reviewing…` in the CR column, not `pending`.
    - `renderPRSlot()` with Fix step absent from workflow renders `Fix —`, not `Fix [░] pending`.
    - `renderPRSlot()` with Fix step present and `phase: 'fixing'` renders `Fix ⠋ applying…`.
    - Completed slot appears in live block for 5s after `completePR()`, then is absent on the next render after the window expires.

- [x] **Board output redesign — section reorder + unified PR line format** — restructure the `watch`/`serve` live board (`board.ts`) so sections read top-to-bottom in information priority order, and tighten the completed-PR two-line format to a consistent `PR | CR | Fix` pipeline layout.
  - **User:** Anyone running `crosscheck watch` or `crosscheck serve` who wants a cleaner, scannable terminal output.
  - **Acceptance Criteria:**
    - **Section order (live block, top to bottom):**
      1. **Summary** — compact single line: aggregate stats (PRs received, CRs completed, fixes applied, avg CR time) + uptime. Replaces `row3` (currently the third line). This anchors the stable numbers at the top where the eye returns.
      2. **Connectivity / status** — tunnel/endpoint URL + alive indicator + `connLog` entries (webhook events, connection events). Currently split between `row1`/`row2` and the conditional `connLog` section; merged into one coherent block.
      3. **Active PR catalog** — active in-flight PR slots (two-line per PR, separated by blank lines). Grows downward as more PRs arrive concurrently; collapses to `waiting for PRs...` when idle.
    - **Completed PR entry format (printed to scrollback via `completePR()`):**
      - Line 1 (unchanged): `HH:MM:SS AM  [verdict badge]  #N  owner/repo  branch  (Xs)  → url`
      - Line 2 (new): `PR [bar 10] Nloc  |  CR [bar 8] N issues (VERDICT)  |  Fix [bar 6] N fixes`
        - Separator is ` | ` (space-pipe-space) between the three pipeline stages.
        - `N issues` replaces the current `·N` suffix — more readable in isolation.
        - `(VERDICT)` appended after issue count in the CR section: `(APPROVE)`, `(NEEDS WORK)`, `(BLOCK)`. Always use the full unabbreviated form — no short aliases.
        - `N fixes` replaces `N applied` — consistent noun form with `N issues`.
        - If fix step did not run (review-only workflow or APPROVE verdict), Fix section reads `Fix ░░░░░░ —` (empty bar, dash) rather than being omitted — keeps the three columns visually consistent.
    - **Active PR slot format (live block, `renderPRSlot()`):**
      - Line 1: spinner + `#N  repo  branch` + right-aligned elapsed + `  ⠋ phase-label` (phase label moves to end of line 1, freeing line 2 for data only).
      - Line 2: same `PR | CR | Fix` layout as completed entries; CR and Fix sections show empty bars with `pending` label until data is available.
    - `board.ts` `render()` function reorders its sections to match the new top/middle/bottom layout; no new public API changes to `PRBoard`.
    - All existing `PRBoard` public methods (`addPR`, `updatePR`, `completePR`, `failPR`, `log`, `logConnectivity`, `setTunnel`, `setConfig`, `start`, `stop`) keep their signatures.
  - **Technical Notes:**
    - `src/lib/board.ts`: reorder `render()` sections; update `renderPRSlot()` line 1/2 split; update `completePR()` line 2 format string.
    - The `statsRow()` and `uptime()` helpers are unchanged — just reposition their output in `render()`.
    - `connLog` and tunnel display move below the stats row rather than above it.
    - The separator lines (`─`.repeat(w-1)) remain — one above the connectivity block, one above/below the PR catalog section.
    - Pending CR/Fix state: use the existing `undefined` check — `slot.verdict === undefined` means CR hasn't arrived yet; `slot.fixCount === undefined` means fix hasn't run. Render `░` bars + `pending` in those cases.
  - **Tests Required:** No new behavioral logic — pure rendering change. Smoke-test: start `watch` against a real PR; verify (a) stats appear at top, (b) tunnel line appears below stats, (c) completed PR entries print in `PR | CR | Fix` format with `(VERDICT)` suffix.
  - **Decided:** Verdict in parentheses uses the full unabbreviated form: `(APPROVE)`, `(NEEDS WORK)`, `(BLOCK)`. Consistent across active slots and completed entries.

- [ ] **Token usage per workflow step — display in two-line status stripe** — track and display the number of tokens consumed by each AI step (review, fix, recheck) and append a compact count to the step label in the per-PR two-line board entry, e.g. `CR ✓ APPROVE (1.2K)`.
  - **User:** Anyone running `crosscheck watch` or `crosscheck serve` who wants visibility into how many tokens each review step consumed, to tune quality tiers or spot unexpectedly large reviews.
  - **Acceptance Criteria:**
    - Each AI step (review, fix, recheck) captures total tokens used from the CLI subprocess output and stores it on `PRSlot` as `crTokens`, `fixTokens`, `recheckTokens` (all `number | undefined`).
    - `renderPRSlot()` appends the token count to the step label when present, formatted as a compact human-readable suffix: `< 1 000 → "(900)"`, `≥ 1 000 → "(1.2K)"`, `≥ 1 000 000 → "(1.2M)"`. Suffix is separated from the step label by a single space, e.g. `CR ✓ APPROVE (1.2K)`.
    - Token count is shown on the completed-PR scrollback line in the same format.
    - When token count is unavailable (CLI did not emit usage data, or step did not run), the suffix is omitted — no `(—)` placeholder.
    - Column widths account for the suffix so the layout does not shift mid-session when counts arrive.
  - **Technical Notes:**
    - `src/reviewers/claude.ts` and `src/reviewers/codex.ts`: parse token usage from subprocess stdout/stderr. Claude CLI emits usage in JSON on stdout when `--output-format json` is passed (field `usage.input_tokens + usage.output_tokens`); Codex emits a `tokens:` line at the end of stderr. Extract and return `tokensUsed: number | undefined` alongside review text. Both functions change return type from `Promise<string>` to `Promise<{ review: string; tokensUsed?: number }>`.
    - `src/lib/board.ts` (`PRSlot`): add `crTokens?: number`, `recheckTokens?: number`. Update `renderPRSlot()` to call a `fmtTokens(n?: number): string` helper that returns the compact suffix or `''`.
    - `fmtTokens` helper: `n == null → ''`, `n < 1000 → \`(${n})\``, `n < 1_000_000 → \`(${(n/1000).toFixed(1).replace(/\.0$/, '')}K)\``, else `(NM)`.
    - `src/lib/runner.ts`: add `crTokens?: number`, `recheckTokens?: number` to `PRPhaseData`; thread token data from reviewer result to `onPhaseChange`; add `tokens_used` field to the `review_complete` log entry.
    - `src/lib/logger.ts`: no structural change needed — `tokens_used` is passed as an ad-hoc field on the existing `review_complete` log event (the `[key: string]: unknown` index signature already covers it).
    - `src/commands/review.ts`: update callers to destructure `{ review }` from the new return type.
  - **Tests Required:**
    - `fmtTokens(undefined)` → `''`.
    - `fmtTokens(900)` → `'(900)'`.
    - `fmtTokens(1200)` → `'(1.2K)'`.
    - `fmtTokens(1000)` → `'(1K)'`.
    - `fmtTokens(1_500_000)` → `'(1.5M)'`.
    - `renderPRSlot()` with `crTokens: 1200` and `phase: 'reviewed'` includes `(1.2K)` after the verdict badge.
    - `renderPRSlot()` with `crTokens: undefined` renders no suffix.

- [ ] **`ck` short alias** — support both `crosscheck [method]` and `ck [method]` as equivalent invocations.
  - **User:** Any developer who wants faster CLI invocations.
  - **Acceptance Criteria:**
    - `ck <command>` works identically to `crosscheck <command>` for all subcommands.
    - `ck --help` shows `Usage: ck [options] [command]` (not `crosscheck`).
    - `crosscheck --help` continues to show `Usage: crosscheck [options] [command]`.
    - Both aliases are published to npm and installed as symlinks on `npm i -g`.
  - **Technical Notes:** Add `"ck": "dist/ck.js"` to `package.json` `bin` field. `src/ck.ts` sets `argv[1]='ck'` via dynamic import so the name is correct on all platforms including Windows shims.
  - **Tests Required:** invocation-name detection unit test; no CLI contract change (patch bump).

- [x] **Fix `watch` event log timestamp misalignment** — zero-pad single-digit hours so all timestamps are the same width (`01:08:08 PM` not `1:08:08 PM`). `fmtTime()` helper added to `board.ts`; all `toLocaleTimeString()` calls replaced.
- [x] **Fix `watch` status bar embedded in scrolling log** — confirmed already anchored via `writeLive()`; no structural change needed.
- [x] **Fix `watch` event log — show failure state in counters** — `errorsOccurred` stat counter added; shown in red in the status bar when > 0, omitted when 0.
- [x] **Fix `watch` event log — improve two-line event readability** — `board.log()` prepends a blank line for 2-line events so consecutive PR entries are visually separated in the scrollback.
- [x] **Fix `crosscheck issue` codex invocation — replace `-q` with `exec` subcommand** — `runWithCodex()` in `src/commands/issue.ts` was calling `codex -q`, which was removed from the Codex CLI; replaced with `codex exec` (issue #57).

- [ ] **`crosscheck issue` — harness guide for directed pattern analysis** — introduce a bundled `ISSUE.md` harness (parallel to `AGENT.md` for `optimize`) that gives the coding agent structured direction when analyzing logs via `crosscheck issue`. Instead of always hunting for error patterns to file a bug report, the agent should be able to run named analyses — session stability, tunnel reliability, throughput trends — and surface patterns with directional context.
  - **User:** Developer running `crosscheck watch` who wants to understand _how_ the tool has been behaving over time, not just _what_ broke. E.g., "why do sessions keep dying?", "are tunnels getting more stable?", "how long does a typical watch session last?"
  - **Background — interaction that shaped this spec (2026-05-10):** Manual analysis of `~/.crosscheck/logs/*.ndjson` across May 7–9 (64 sessions, ~9,400 events) revealed: average session lifespan of 32.1 min; 50% of sessions had no `session_end` (abrupt kill); a 3.5-hour rapid-restart storm on May 9 09:08–12:38 UTC (19 sessions, none reached `tunnel_opened`); 236 tunnel errors (208 SSH timeouts, 28 SSH code-255 exits); longest stable session 275 min. None of these patterns were surfaced by `diagnose` because they require session-level reasoning, not error-row counting. This is the analysis the harness should be able to perform.
  - **Acceptance Criteria:**
    - `ISSUE.md` exists at the package root and is included in the npm package (`files` in `package.json`).
    - The harness defines at minimum these named analyses, each with: what data to read, what to compute, and what the output format should be:
      - **`session-stability`** — per-session table (start, end, duration, tunnel URL, end reason clean vs inferred), aggregate stats (total sessions, average lifespan, min/max, clean-exit %, crash %). Crash = no `session_end`. Flag sessions where `session_end` is absent but a `tunnel_opened` was logged (suggests abrupt kill, not startup failure).
      - **`tunnel-reliability`** — counts of `tunnel_opened`, `tunnel_closed`, `tunnel_error` by error subtype (SSH timeout, SSH code-255, other); reconnect rate (`reconnecting: true`); terminal close rate; % of sessions that never reached `tunnel_opened`.
      - **`throughput`** — PRs received, reviews completed, fixes applied, per-day and per-session averages.
    - `crosscheck issue --analysis <name>` runs the named analysis using the selected coding agent and prints the structured report to stdout. No GitHub issue is filed for analysis runs (unlike the default bug-report flow).
    - `crosscheck issue --analysis session-stability` is the canonical way to get the session report we produced manually on 2026-05-10.
    - `crosscheck issue --list-analyses` prints the available analysis names from the active harness.
    - Harness override: looks for `ISSUE.md` at `{cwd}/ISSUE.md` → `{cwd}/.crosscheck/ISSUE.md` → bundled. Same override pattern as `AGENT.md` in `optimize`.
    - Agent selection: reuses `selectOptimizeAgent()` — same vendor-selection logic (prefer higher-success-rate vendor; fallback to claude).
    - Analysis output is printed to stdout; exit 0 always (reporting tool, not a gate).
    - `--since <date>` scopes the log window (default: last 7 days).
    - `--json` emits the structured report as JSON for scripting.
  - **Technical Notes:**
    - New file: bundled `ISSUE.md` at package root. Plain Markdown; no build step. Keep under 400 lines.
    - `src/commands/issue.ts`: add `--analysis <name>` and `--list-analyses` flags to the existing Commander definition. When `--analysis` is present, skip the interactive bug-report flow entirely; build the analysis prompt from the harness section matching `<name>`, invoke the agent via `runWithClaude` / `runWithCodex`, stream output to stdout.
    - New helper `src/lib/harness.ts`: `loadIssueHarness(cwd: string): string` — same override lookup as `loadAgentHarness` in `optimize.ts`. `parseAnalysisNames(harness: string): string[]` — extracts `## <name>` sections.
    - `ISSUE.md` structure: one `## <analysis-name>` section per named analysis; each section contains: `### Input` (which log events and fields to read), `### Computation` (what to calculate), `### Output format` (markdown table or JSON schema). Prose-only; no code in the harness.
    - Log parsing for analysis runs: reuse `loadErrorEntriesForPattern` / `sanitizeEntry` where applicable; for session-level analysis, build a `groupBySessions(entries)` helper that splits on `session_start` events.
    - New function `src/lib/log-analysis.ts`: `groupBySessions(entries: RawLogEntry[]): Session[]` where `Session = { start: Date; end: Date | null; events: RawLogEntry[]; tunnelUrl: string | null; cleanExit: boolean }`.
  - **Tests Required:**
    - `groupBySessions` splits entries correctly on multiple `session_start` events; last session with no `session_end` gets `cleanExit: false`.
    - `parseAnalysisNames` extracts correct section names from a fixture harness string.
    - `loadIssueHarness` respects override order (cwd → .crosscheck → bundled).
    - `--list-analyses` prints names without invoking an agent.
    - `--analysis unknown-name` exits 1 with a clear message listing valid names.
    - `--json` output is valid JSON; `--since` filters log files by date correctly.

- [x] **`crosscheck diagnose`** — analyze `~/.crosscheck/logs/*.ndjson`, surface failure patterns and review quality signals as a human-readable report (with `--json` for machine output). This is the observability foundation that `optimize` and future tooling build on.
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

- [x] **`crosscheck optimize`** — run `diagnose` internally, select the best available local AI agent, feed the report into it using `AGENT.md` as the harness, diff the result against `~/.crosscheck/instructions.md`, and apply on `--apply`. Dry-run by default.
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

- [x] **`AGENT.md` — bundled optimize harness** — ship a well-crafted `AGENT.md` at the repo root that guides claude during `optimize`. This file defines how to read diagnose output, detect languages, write good constraints, and stay within quality guardrails.
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

- [x] **Adaptive instructions file** — both `codex.ts` and `claude.ts` read `~/.crosscheck/instructions.md` and append its content to the review prompt / `.codex/instructions`. Seeded with safe defaults on first run. Replaces the hardcoded `noBuildToolsNote` in `codex.ts`.
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

- [x] **Local debug log file** — persist structured runtime logs to `~/.crosscheck/logs/` for debugging. Enabled by default; configurable retention (default 7 days, max 30).
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
- [x] **Auto-detect `allowed_authors` on first run** — `crosscheck init` and `crosscheck watch` detect the signed-in GitHub login via `gh api user` and write it to `routing.allowed_authors` in the config automatically. One-time: once written, subsequent runs skip detection. Prevents the footgun of reviewing all PRs in an org because the author filter was never set.

- [x] **Fix `watch` banner display real-estate** — compress three banner rows (`deployment`, `mode`, `quality`) into a single `profile` row; show users repo-count inline on the `users` row instead of as an indented sub-row. Net: banner shrinks from 8 rows to 5 rows.
  - **Why:** the `mode` and `quality` values already appear in the live status line, making their banner rows redundant. The users sub-row had inconsistent indentation and used a line for metadata (repo count) that belongs inline.
  - **How:** `watch.ts` banner emits `  profile    <deployment> · <mode> · <quality>` and `  users  <login> (<n> repos)`. The `config ← edit to change above` hint stays on the config row.

- [x] **Fix `watch` live board separator wrap glitch and idle height** — separator width changed from `w` to `w - 1` (prevents exact-terminal-width cursor ambiguity that causes the next line's `●` to appear at the end of the separator); `writeLive` now counts visual rows (accounts for wrapping) instead of logical newlines; connectivity section only rendered when it contains entries (removes 3 always-present empty rows in the idle state).
  - **Why:** full-width separators trigger an ambiguous terminal cursor position that made consecutive render frames appear on the same line. Empty connectivity rows wasted vertical space and inflated the `liveLines` count, causing eraseLive to under-erase.

- [x] **Fix `origin/<base>` ref missing in PR clone — reviews receiving 0loc** — `git fetch origin <base>:<base>` creates a local branch but not the `origin/<base>` remote-tracking ref that `codex review --base <branch>` and `computePRLoc` require. Changed to `git fetch origin <base>` (no refspec) which properly populates `origin/<base>`.
  - **Why:** codex internally runs `git diff origin/<base>...HEAD`; without the remote-tracking ref the diff fails silently, the review runs against an empty diff, and the completion line shows `0loc` even though the PR has code changes.
  - **How:** `watch.ts` clone setup replaces `execSync('git fetch origin ${ref}:${ref}', ...)` with `execSync('git fetch origin ${ref}', ...)`.

- [ ] **Deployment Mode & Smart Scope Detection** — formalize the three monitoring scope levels (repo, org, user/personal) and introduce a `deployment: personal | team` config field. `crosscheck watch` and `crosscheck serve` each prompt the user to choose a mode on first run (when `deployment` is absent from config), then auto-detect scopes from GitHub credentials and write the result to config. Subsequent runs skip the prompt entirely. Closes the gap where AI agents opening PRs to personal repos go unwatched, and removes the footgun of serving an entire org with no author filter in team mode.
  - **User:** Personal developer running `crosscheck watch` (wants all of their own PRs reviewed across personal repos and orgs). Team operator running `crosscheck serve` (wants all org PRs reviewed, personal repos excluded).
  - **Acceptance Criteria:**

    **Scope levels (all three work independently and combine additively):**
    - `repos:` — monitor specific repos. At startup, validate each configured repo is accessible via GitHub API; log `✗ repo not found or inaccessible: owner/name — skipped` and continue (do not crash).
    - `orgs:` — monitor all repos in the listed orgs via one org-level webhook per org.
    - `users:` — monitor all non-archived repos owned by the listed GitHub personal accounts; enumerated at startup via `GET /users/{username}/repos?type=owner`.

    **`deployment` config field:**
    - New top-level field: `deployment: personal | team`. No default in schema — absence triggers the first-run prompt in watch/serve.
    - `personal` — monitors `users=[self]` + `orgs=[all-memberships]`; `allowed_authors=[self]` (only the owner's PRs reviewed).
    - `team` — monitors `orgs=[all-memberships]` only (no personal repos); `allowed_authors=[]` (all PRs in org scope reviewed).

    **`crosscheck init` — no change to scope logic:**
    - Remains a pure environment check: CLIs, GitHub token, webhook secret, config file creation.
    - Does not prompt for deployment mode; does not detect org memberships.
    - Existing `allowed_authors` auto-detection behaviour is preserved for backward compatibility.

    **First-run prompt in `crosscheck watch` and `crosscheck serve`:**
    - Triggered once when `deployment` key is absent from config (i.e., first run or pre-existing config from an older version).
    - Printed before the startup banner:
      ```
      How are you using crosscheck?

        [1] personal  — monitor all your repos and orgs; review only PRs you author
        [2] team      — monitor org repos only; review all PRs from any author

      Choice [1]:
      ```
    - Default is `[1]` (personal). Pressing Enter accepts the default.
    - After the user chooses, crosscheck detects GitHub login + org memberships, writes `deployment:`, `users:` (personal only), `orgs:`, and `allowed_authors:` to config, then continues startup without restart.
    - Subsequent runs: `deployment` is present → prompt is skipped entirely.

    **One-time override — `--personal` / `--team` flags:**
    - Use the specified mode for this session only. Config is not read or written.
    - Scopes are auto-detected at runtime (same detection logic as normal mode); nothing persisted after exit.
    - Intended for CI pipelines, one-off runs, or trying a mode before committing to it.
    - Example: `crosscheck watch --team` reviews all org PRs this session; next run reverts to whatever `deployment` says in config.

    **Permanent reconfigure — `--reconfigure` flag:**
    - Re-triggers the setup prompt unconditionally, even if `deployment` is already set.
    - Shows current saved mode: `Current: personal`.
    - After the user chooses, overwrites `deployment:`, `users:`, `orgs:`, `allowed_authors:` in config.
    - Useful when joining a new org, switching from personal to team use, or correcting a first-run mistake.
    - Example: `crosscheck watch --reconfigure`.

    **`crosscheck watch` runtime behavior (after mode is known):**
    - When `users`, `orgs`, `repos` are all empty: auto-detect scopes from GitHub credentials based on `deployment`. Prints `  ✦ scopes auto-detected from GitHub credentials`.
    - Explicit `users`/`orgs`/`repos` in config always take precedence over auto-detection.
    - Banner shows `  deployment  personal` or `  deployment  team`.

    **`crosscheck serve` runtime behavior (after mode is known):**
    - Same auto-detection logic as watch, keyed on `deployment`.
    - In `team` mode with empty `allowed_authors`, replace the existing warning with: `  author filter  all PRs (team mode — set allowed_authors to restrict)`.
    - Banner shows deployment mode.

  - **Technical Notes:**
    - Schema: add `deployment: z.enum(['personal', 'team']).optional()` to `ConfigSchema` — intentionally no default so absence can trigger the prompt.
    - New function `src/github/client.ts`: `listUserOrgs(token: string): Promise<string[]>` — `GET /user/memberships/orgs?state=active&per_page=100`, paginates, returns org login strings; returns `[]` on error (never throws).
    - New function `src/github/client.ts`: `checkRepoAccessible(owner: string, repo: string, token: string): Promise<boolean>` — returns false on 404/403, true on 200.
    - New function `src/config/loader.ts`: `detectScopesForDeployment(deployment: 'personal' | 'team', token: string): Promise<{ users: string[]; orgs: string[] }>` — calls `detectGitHubLogin()` + `listUserOrgs()`; returns `{ users: [login], orgs }` for personal, `{ users: [], orgs }` for team.
    - New function `src/config/loader.ts`: `patchDeploymentConfig(configPath, deployment, login, orgs): boolean` — writes `deployment:`, `users:` (personal only), `orgs:`, `allowed_authors:` to config YAML; no-op if `deployment` key already present (use `force: true` to overwrite for `--reconfigure`).
    - Repo accessibility check: `watch.ts` and `serve.ts`, after loading `config.repos`, call `checkRepoAccessible` for each in parallel; log warning and filter out inaccessible ones before building scopes.
    - `watch.ts` / `serve.ts`: prompt logic runs before the startup banner. `--personal`/`--team` skip all config reads/writes and use runtime-only scopes. `--reconfigure` runs the prompt with `force: true` and rewrites config.
    - `crosscheck.config.example.yml`: add commented `deployment: personal` with explanation of both values.
    - `get-started.md`: add a **Deployment mode** section documenting the three flags.
  - **Tests Required:**
    - `listUserOrgs` paginates correctly; returns `[]` on API error.
    - `checkRepoAccessible` returns false on 404; true on 200.
    - `detectScopesForDeployment('personal', token)` → `{ users: [login], orgs: [...] }`.
    - `detectScopesForDeployment('team', token)` → `{ users: [], orgs: [...] }`.
    - `patchDeploymentConfig` writes all fields; is a no-op if `deployment` present and `force` is false; overwrites when `force: true`.
    - First-run prompt shown when `deployment` absent; not shown when present.
    - `--personal` flag: uses personal scopes this session; config is not written.
    - `--team` flag: uses team scopes this session; config is not written.
    - `--reconfigure` flag: shows prompt even when `deployment` already set; shows current mode; writes new choice to config.
    - Watch with empty scopes + `deployment: personal` → auto-detects users + orgs.
    - Watch with empty scopes + `deployment: team` → auto-detects orgs only.
    - Serve `team` mode + empty `allowed_authors` → shows positive confirmation, not warning.
    - Inaccessible repo in `repos:` → warning logged, repo skipped, remaining repos monitored.

- [x] **Live connectivity log section in `watch` dashboard** — add a dedicated 2-line section between the top status dashboard and the per-PR work area. Shows the 2 most recent connectivity events (tunnel open/close, webhook registrations) in-place without cluttering the scrollback.
  - **User:** Anyone running `crosscheck watch` who wants to see tunnel/webhook status at a glance alongside active PR work.
  - **Acceptance Criteria:**
    - A fixed 2-line connectivity section appears between the 3-row dashboard and the PR slots in the live display.
    - Shows the 2 most recent events: tunnel ready, tunnel disconnected, webhook registered, webhook failed.
    - Each line is timestamped: `  9:18:14 AM  ✓ tunnel ready: https://...`
    - Lines are padded with empty strings until 2 events have occurred, so the section height is stable.
    - Connectivity events do NOT appear in the scrollback (they are in-place only).
    - Tunnel errors and webhook errors still also appear in scrollback via `bLog` (so they're not lost on reconnect).
  - **Technical Notes:**
    - `board.ts`: add `private connLog: string[]` (max 2 entries); `logConnectivity(line): void` appends with timestamp, shifts oldest when full.
    - `render()`: add `Section 1.5` between `sep` and PR slots, always `CONN_LOG_MAX` lines.
    - `watch.ts`: add `cLog(line)` helper → `board.logConnectivity(line)` + `fileLog`; route tunnel open/close/fail and webhook registered/failed to `cLog`.

- [ ] **Comment-based attribution detection (P2 step 4)** — extend `detectOriginFull` to scan PR review comments for crosscheck annotation tags (`<!-- crosscheck: origin=... -->`), positioned after body/commit/branch checks and before `author_routes`. This is the mechanism that enables P3 annotations to feed back into future detections.
  - **User:** Anyone running crosscheck on repos where PRs are authored by agents that don't leave body footers (e.g., agents that only commit code, or agents whose PR template doesn't include attribution text).
  - **Acceptance Criteria:**
    - `detectOriginFull` gains a new step 4: if steps 1–3 return null, fetch PR comments via `GET /repos/{owner}/{repo}/issues/{number}/comments`; scan each body for `<!-- crosscheck: origin=(claude|codex) -->`. Return the first match found.
    - Step 4 is only called when steps 1–3 are inconclusive — no extra API call on the fast path.
    - Comment fetch failure is non-fatal; falls through to `author_routes` (same pattern as commit fetch).
    - `detectOriginFull` logs `method: 'comment'` when attribution is resolved at this step.
    - Works correctly with both `<!--` (HTML comment) and `<!-- crosscheck: ... -->` — the crosscheck annotation subset.
  - **Technical Notes:**
    - New function `src/github/client.ts`: `listPRComments(owner, repo, prNumber, token): Promise<string[]>` — returns comment bodies, paginated (100/page).
    - `src/github/detector.ts`: new step between branch check and author_routes; wraps `listPRComments` + `matchPatterns` on the annotation tag `<!-- crosscheck: origin=(claude|codex)`.
    - Annotation regex: `/<!--\s*crosscheck:\s*origin=(claude|codex)/i` — case-insensitive, whitespace-tolerant.
    - `src/__tests__/detector.test.ts`: add test cases for comment-resolved attribution (mock `listPRComments`), step-4-skipped-when-body-matches, API failure falls through.
  - **Tests Required:** Step 4 resolves 'claude' from annotation tag; step 4 resolves 'codex'; step 4 not called when body matches; step 4 API failure → falls through to author_routes; no annotation tag in comments → falls through; annotation tag with extra fields → still matches.

- [ ] **`routing.fallback_reviewer` config field (P2 assignment)** — when attribution detection returns 'human' or unknown in cross-vendor mode, apply a configured policy instead of silently skipping. Default `skip` preserves backward-compatible behavior; setting to `claude` or `codex` ensures all unattributed in-scope PRs get reviewed.
  - **User:** Anyone running crosscheck on repos where PR attribution is inconsistent — mixed human/AI authors, agents that don't leave footers, or early adopters who want to ensure 100% coverage regardless of attribution confidence.
  - **Acceptance Criteria:**
    - New field `routing.fallback_reviewer: 'claude' | 'codex' | 'skip'` in `RoutingConfigSchema`, default `'skip'`.
    - `assignReviewer` uses `fallback_reviewer` when `origin === 'human'` in cross-vendor mode. Returns `null` when `skip`; returns the named vendor when `claude` or `codex`.
    - Existing behavior (silently skip human-origin PRs) is preserved when `fallback_reviewer` is absent or `'skip'`.
    - `serve.ts` / `watch.ts` log `origin_method: 'none', fallback: 'claude'` (or skip) when the fallback fires.
    - `crosscheck.config.example.yml` documents the field with a comment explaining the coverage/noise tradeoff.
    - `crosscheck status` shows the active fallback policy.
  - **Technical Notes:**
    - `src/config/schema.ts`: add `fallback_reviewer: z.enum(['claude', 'codex', 'skip']).default('skip')` to `RoutingConfigSchema`.
    - `src/github/detector.ts`: `assignReviewer` already returns `null` for `origin === 'human'` in cross-vendor mode; update to `return config.routing.fallback_reviewer === 'skip' ? null : config.routing.fallback_reviewer`.
    - `crosscheck.config.example.yml`: add commented `fallback_reviewer: skip` under `routing:`.
  - **Tests Required:** `fallback_reviewer: 'skip'` → null on human origin; `fallback_reviewer: 'claude'` → 'claude' on human origin; `fallback_reviewer: 'codex'` → 'codex' on human origin; single-vendor mode ignores fallback_reviewer; cross-vendor with both vendors enabled + fallback → fallback vendor returned; named fallback vendor is disabled → still returned (reviewer availability check is separate).

- [ ] **Crosscheck annotation system (P3)** — embed machine-readable attribution metadata in every review comment crosscheck posts, and in every commit crosscheck pushes. This creates a durable, self-consistent attribution record that Step 4 detection (comment-based) can read on future events.
  - **User:** Long-running crosscheck installations where PRs accumulate history — reruns, rechecks, follow-up commits. Without annotations, each event re-infers attribution from scratch, which can diverge if PR body is edited or commits are amended.
  - **Acceptance Criteria:**
    - Every review comment posted by `postReviewComment` in `client.ts` appends `\n<!-- crosscheck: origin=<origin> reviewer=<reviewer> verdict=<verdict> -->` to the comment body (after the existing footer).
    - Every `[crosscheck]` commit pushed in `address` step includes `Crosscheck-Reviewer: <reviewer>` as a Git trailer in the commit message.
    - The annotation tag is invisible in GitHub's rendered Markdown (HTML comment).
    - `parseAnnotation(commentBody: string): { origin: PROrigin; reviewer: string; verdict: string } | null` — pure function in `src/lib/annotation.ts`. Returns null if no tag found.
    - `postReviewComment` accepts `origin` parameter (already known at call site in serve.ts/watch.ts) and embeds it.
    - Round-trip: `parseAnnotation(postReviewComment output)` returns the correct origin/reviewer/verdict.
    - Annotation format is tested as a stable schema — any format change is flagged in tests.
  - **Technical Notes:**
    - New file `src/lib/annotation.ts`: `buildAnnotation(origin, reviewer, verdict): string` → `<!-- crosscheck: origin=<o> reviewer=<r> verdict=<v> -->`; `parseAnnotation(body): Annotation | null` — regex parse.
    - `src/github/client.ts`: `postReviewComment` gains `origin: PROrigin` parameter; appends `buildAnnotation(origin, reviewer, verdict)` after the existing footer.
    - Call sites in `serve.ts` / `watch.ts` / `review.ts`: pass `origin` to `postReviewComment`.
    - `src/lib/runner.ts` `address` step: append `\nCrosscheck-Reviewer: <reviewer>` to `[crosscheck]` commit message.
    - `src/__tests__/annotation.test.ts`: round-trip tests; format stability tests (snapshot the exact tag string).
  - **Tests Required:** `buildAnnotation('claude', 'codex', 'APPROVE')` produces expected tag; `parseAnnotation` returns correct fields; `parseAnnotation` on comment without tag returns null; `parseAnnotation` is whitespace-tolerant; annotation appended correctly to full comment body; round-trip: build then parse returns original values; format snapshot — tag string does not drift between test runs.

- [ ] **Custom Workflow Engine** — `workflow.yml` per-repo pipeline definition: ordered steps (`review`, `address`, `recheck`), `when` conditions on verdict/context, per-step `instructions` for behavior steering, and `max_rounds` guard. Enables the review → auto-fix → re-review loop without code changes.
  - **User:** Teams with high PR volume who want crosscheck to close the feedback loop, not just comment. Also teams that want different reviewer behavior at each pipeline stage.
  - **Acceptance Criteria:**
    - `loadWorkflow(repoDir, configDir)` always returns a valid step list. When no `workflow.yml` is found, it returns the `DEFAULT_WORKFLOW` constant (single `review` step) — no separate fallback code path.
    - `watch.ts`/`serve.ts` always call `loadWorkflow` + `runWorkflow`; there is no conditional that bypasses the runner for the no-file case.
    - `crosscheck init` generates a `.crosscheck/workflow.yml` template with the default step active and `address`/`recheck` steps present but commented out.
    - Supported step types: `review` (run AI reviewer, post comment), `address` (read review comment, commit fixes to PR branch), `recheck` (re-review after fixes).
    - `when` field: evaluated as a boolean expression; step skipped if false. Supported context: `verdict`, `<step-name>.applied_count`, `<step-name>.verdict`.
    - Per-step `instructions` field appended to AI prompt for that step only, extending global `~/.crosscheck/instructions.md`.
    - `max_rounds` on `address` steps (default 1); hard cap of 5 `[crosscheck]` commits per PR.
    - All `address` commits prefixed `[crosscheck]` in the message.
    - `crosscheck review <pr-url> --workflow` exercises the full workflow against a single PR for testing.
    - No `address` step ever merges; `auto_merge` is always false.
  - **Technical Notes:**
    - `src/lib/workflow.ts`: `DEFAULT_WORKFLOW` constant; Zod-validated schema; `loadWorkflow(repoDir, configDir)` returns `DEFAULT_WORKFLOW` when no file found — never null.
    - `src/lib/runner.ts`: `runWorkflow(steps, context)` — iterates steps, dispatches handlers.
    - `address` handler: parse AI response as file-level patches → `git apply` → push `[crosscheck]` commit.
    - `when` evaluation: minimal expression evaluator (equality + comparison, no scripting engine).
    - `watch.ts`/`serve.ts`: unconditionally call `loadWorkflow` + `runWorkflow`; delete the direct reviewer call.
    - `init.ts`: write `.crosscheck/workflow.yml` template during init (see Feature Design section).
  - **Tests Required:** `loadWorkflow` returns `DEFAULT_WORKFLOW` on absent file; `loadWorkflow` parses a valid file correctly; `when: "verdict == 'APPROVE'"` skips `address` step; `max_rounds` cap respected; `address` commits prefixed `[crosscheck]`; runner with `DEFAULT_WORKFLOW` produces identical output to current direct-call behavior.

- [ ] **Auto-init on `watch`/`serve`** — `crosscheck watch` and `crosscheck serve` detect whether first-time setup has been done and run init steps automatically before starting the monitor. `crosscheck init` becomes optional, not required.
  - **User:** Anyone running crosscheck for the first time. The current expectation ("run init first") is undiscoverable — most users just try `crosscheck watch` and hit missing-config errors.
  - **Acceptance Criteria:**
    - On `crosscheck watch` / `crosscheck serve` startup, before opening the tunnel or binding the port, call `ensureInit(cwd)`.
    - If `~/.crosscheck/.initialized` exists and contains the current crosscheck version, `ensureInit` skips global setup (webhook secret generation) but still runs cheap `existsSync` checks for the two repo-local files (`crosscheck.config.yml`, `.crosscheck/workflow.yml`). If either is missing, it is created before returning. No subprocess spawns on the fast path.
    - If sentinel is absent or version differs, print `  ✦ first run — setting up crosscheck...`, run missing setup steps, write sentinel, then continue.
    - Auth checks (gh, claude, codex CLIs) remain in `crosscheck init` only — not run by `ensureInit` (they require subprocess spawns and would defeat the fast-path goal).
    - After auto-init completes, watch/serve continues normally without requiring a restart.
    - `crosscheck init` remains a standalone command; bypasses sentinel (`--force` internally) and always runs the full check + prints status table. Re-running does not overwrite existing files.
    - `--no-init` flag on `watch`/`serve` skips the `ensureInit` call entirely for CI environments.
  - **Technical Notes:**
    - New file: `src/lib/setup.ts` — `ensureInit(cwd, opts?)`: sentinel check first; on miss, runs setup steps and writes `~/.crosscheck/.initialized`.
    - `init.ts` calls `ensureInit` with `{ force: true, verbose: true }` then prints status table.
    - `watch.ts` / `serve.ts`: `await ensureInit(process.cwd())` before `loadConfig`.
  - **Tests Required:** sentinel present + version match + repo-local files exist → no files written; sentinel present + version match + repo-local files absent → creates missing repo-local files only (no webhook secret re-generated); sentinel absent → runs all three setup steps; sentinel version mismatch → re-runs changed steps; `--no-init` bypasses call; `crosscheck init` overwrites sentinel even if present; second repo with same version → repo-local files created even though sentinel already exists.

- [ ] **`crosscheck issue`** — scan recent logs for errors, draft a GitHub issue using the local AI agent, ask targeted multiple-choice follow-up questions, and submit to `motivation-labs/crosscheck` after user confirmation. Zero manual log-digging required.
  - **User:** Anyone who hits a recurring or unexpected review failure and wants to report it without writing the issue from scratch or navigating log files manually.
  - **Acceptance Criteria:**
    - `crosscheck issue` reads `~/.crosscheck/logs/` for the most recent 3 days (default); `--since YYYY-MM-DD` overrides the window.
    - Reuses the same error-grouping logic as `diagnose` (extracted into `src/lib/log-analysis.ts`). If no `error`-level entries are found, prints `No errors found in recent logs — nothing to report` and exits 0.
    - If multiple error patterns are found, shows a numbered menu and prompts `Which issue do you want to report? [1–N]` before proceeding.
    - Passes the selected log entries + current version, platform, and config summary (mode, enabled vendors — no repo names or secrets) to the local AI agent to draft an issue with: a concise **title**, **description** (what failed and likely cause), **steps to reproduce** (inferred from the log event sequence), **sanitized log excerpt**, and **environment block** (version, platform, reviewer, config mode).
    - After generating the draft, asks exactly 3 targeted multiple-choice questions to improve the report:
      1. `Can you reproduce this consistently?` → `[1] Every time  [2] Sometimes  [3] Happened once`
      2. `Which command triggered this?` → `[1] watch  [2] serve  [3] review  [4] Unknown` (skip if unambiguous from logs)
      3. `Is this blocking you from using crosscheck?` → `[1] Blocked  [2] Degraded  [3] Cosmetic` (sets label priority)
      Answers are appended to the issue body under `## User Context`. No free-text input required.
    - Shows the final draft in the terminal and prompts `Submit to motivation-labs/crosscheck? [y/N]`.
    - `--yes` / `-y` skips the confirmation step and submits immediately after displaying the draft.
    - `--dry-run` prints the draft and exits 0 without calling `gh`, regardless of `--yes`.
    - Submission uses `gh issue create --repo motivation-labs/crosscheck`. Falls back to printing the exact `gh issue create` command the user can copy-run if `gh` is not authenticated or the call fails.
    - Adds label `bug` always; adds label `priority:high` when impact answer is `Blocked`.
    - On success, prints the issue URL.
  - **Sanitization rules (non-negotiable — applied before passing log entries to AI and before posting):**
    - Strip: `owner/repo` patterns, PR titles, file paths, GitHub usernames, branch names, any string matching a GitHub URL.
    - Replace with: `[repo]`, `[pr-title]`, `[file-path]`, `[username]`.
    - Webhook secrets and tokens are never present in log entries (enforced by `logger.ts`) — no special handling needed.
  - **Technical Notes:**
    - New file: `src/commands/issue.ts`.
    - Extract error-grouping logic from `diagnose.ts` into `src/lib/log-analysis.ts`; both `diagnose.ts` and `issue.ts` import from it.
    - Agent selection: same `selectOptimizeAgent(config, report)` from `optimize.ts`.
    - Agent prompt structure:
      ```
      You are drafting a GitHub issue for the crosscheck project.

      Error pattern: {pattern}
      Frequency: {count} occurrences in the last {days} days

      Sanitized log entries:
      {entries}

      Environment: crosscheck {version} · {platform} · reviewer: {reviewer} · mode: {mode}

      User context:
      - Reproducibility: {reproducibility}
      - Trigger: {command}
      - Impact: {impact}

      Output exactly:
      TITLE: <title>
      ---
      <markdown body>
      ```
    - Parse `TITLE:` line as issue title; everything after `---` as the body.
    - Wire into `cli.ts` as `crosscheck issue [--since <date>] [--dry-run] [--yes]`.
  - **Tests Required:** sanitizer removes repo names, PR titles, file paths, usernames; no errors found → exits 0 with message; multiple patterns → prompts menu; `--dry-run` prints draft and skips `gh`; `--yes` skips confirmation; draft parsing extracts title and body correctly; `gh` not authenticated → prints manual command; `priority:high` label added when impact is `Blocked`.
- [ ] **`crosscheck impact`** — report cumulative value crosscheck has created: time saved through automation, issues caught before merge, and second-order code quality signals. Pulls from local logs; no telemetry, no network calls.
  - **User:** Anyone who wants to understand whether crosscheck is pulling its weight — developers justifying continued use, team leads making tooling decisions, engineering managers tracking process improvement.
  - **Acceptance Criteria:**
    - `crosscheck impact` prints a human-readable report to stdout; `--json` outputs structured JSON.
    - `--since YYYY-MM-DD` limits the analysis window (default: all time).
    - **Time-saving section:**
      - Shows total PRs reviewed, total estimated human-hours saved, and average minutes saved per PR.
      - Calculation: `time_saved_per_pr = assumed_human_review_min − actual_ai_review_min`. Default `assumed_human_review_min = 60` (configurable via `impact.assumed_human_review_minutes` in `crosscheck.config.yml`). `actual_ai_review_min` is derived from `review_complete.duration_ms` in the logs; falls back to 2 min when data is absent.
      - Displays the assumption so users can calibrate: `  ⓘ assumes 60 min avg human review — set impact.assumed_human_review_minutes to adjust`.
    - **Issues caught section:**
      - APPROVE / NEEDS_WORK / BLOCK verdict counts and percentages.
      - `issues_caught = NEEDS_WORK + BLOCK` verdicts — PRs that would have shipped with unreviewed feedback had crosscheck not run.
      - BLOCK count surfaced separately with a plain-language note: "potential bugs or breaking changes caught before merge".
    - **Code quality signal section:**
      - Trend line: BLOCK rate over the analysis period (weekly buckets). A declining BLOCK rate may indicate improved code quality upstream.
      - Top file types with NEEDS_WORK/BLOCK verdicts — surfaces where the most issues appear.
    - **Monetary estimate (opt-in):**
      - Hidden by default; shown with `--money`.
      - Formula: `estimated_value = (hours_saved × hourly_rate) + (issues_caught × defect_cost)`. Defaults: `hourly_rate = 150` (USD), `defect_cost = 150` (one hour of engineer time per issue). Both configurable via `impact.hourly_rate_usd` and `impact.defect_cost_usd`.
      - Shown with a clear disclaimer: "rough estimate based on configurable assumptions; not accounting data."
    - Exit 0 always (reporting tool, not a gate).
    - Gracefully handles empty log dir: prints `No review data yet — run crosscheck watch to start collecting.`
  - **Technical Notes:**
    - New file: `src/commands/impact.ts`.
    - Reuse the log parser from `diagnose.ts` — extract into `src/lib/log-reader.ts` if not already a standalone module.
    - New config fields in `schema.ts`:
      ```
      ImpactConfigSchema = z.object({
        assumed_human_review_minutes: z.number().int().min(1).default(60),
        hourly_rate_usd: z.number().min(0).default(150),
        defect_cost_usd: z.number().min(0).default(150),
      })
      ```
      Added to `ConfigSchema` as `impact: ImpactConfigSchema.default({})`.
    - Duration data comes from `review_complete` log entries that include `duration_ms`. For entries without duration, omit them from the per-review average (don't assume a value).
    - Verdict data comes from `review_complete` log entries with a `verdict` field. Entries with no verdict are counted as `UNKNOWN` and excluded from BLOCK/NEEDS_WORK totals.
    - Wire into `cli.ts` as `crosscheck impact [--json] [--since <date>] [--money]`.
    - `crosscheck status` gets a one-line impact summary appended: `  impact  47 PRs reviewed · ~23h saved · 8 issues caught` — linking to full `crosscheck impact` for details.
  - **Calculation methodology (basis):**
    - **Time saved per PR**: Industry research (Google Engineering Productivity, Microsoft Research SPACE framework) puts median human code review time at 60–90 min per PR for non-trivial changes. The 60 min default is conservative. AI turnaround measured from log `duration_ms` is typically 1–3 min. Net saving per PR: ~57 min at default settings.
    - **Defect cost**: NIST studies put post-merge defect fix cost at 4–10× the cost of catching it during review. At $150/hr and 1 hr median fix time, each issue caught pre-merge is conservatively worth $150. BLOCK-severity issues are not weighted more (keeps the math transparent and conservative).
    - **Second-order quality signal**: Declining BLOCK rate over time is a leading indicator that PRs are getting cleaner upstream — teams internalize review feedback. This is a proxy metric, not a hard measurement.
  - **Tests Required:** empty log dir → graceful no-data message; log with mixed verdicts → correct APPROVE/NEEDS_WORK/BLOCK counts; duration data present → `actual_ai_review_min` calculated correctly; duration data absent → falls back to default; `--since` filters log entries by date; `--json` output is valid JSON matching schema; `--money` flag gates monetary estimate display; `crosscheck status` shows one-line summary.

- [ ] **`crosscheck coverage` — Gap Analysis and Self-Improvement Engine** — compare what crosscheck *should* have reviewed (monitored scope × live uptime) against what it *actually* reviewed (logs), identify the root cause of each missed PR, and route the finding to the appropriate remediation: config fixes are applied or filed as best-practice issues; feature gaps become prd.md proposals that can optionally be auto-contributed as PRs to `motivation-labs/crosscheck`.
  - **User:** Anyone who has been running crosscheck for a week or more and wants to know whether it's actually catching everything it should be, and what to do about the gaps.
  - **Acceptance Criteria:**

    **Coverage measurement:**
    - Computes an *uptime window* from `session_start` events in `~/.crosscheck/logs/` — the union of all periods crosscheck was running.
    - For each repo/org/user in the current config, calls the GitHub API to enumerate all PRs opened or updated during the full analysis period (from the earliest `session_start` in logs, or `--since` if provided — not limited to uptime windows). This ensures PRs that were active only while crosscheck was offline are still enumerated and can be classified as `offline_window`.
    - Cross-references that list against `pr_received` + `review_complete` log entries to find PRs in scope that were never reviewed.
    - Reports a coverage percentage per scope and overall: `63 / 71 PRs reviewed (89%)`.

    **Gap classification — each missed PR is classified into exactly one root cause:**

    | Cause | Meaning | Action type |
    |---|---|---|
    | `author_filtered` | PR author not in `allowed_authors` | `config_fix` |
    | `no_attribution` | PR body has no Claude/Codex footer and no `author_routes` entry | `config_fix` |
    | `no_reviewer` | Attribution detected but no vendor enabled for that origin | `config_fix` |
    | `offline_window` | PR opened while crosscheck was not running | `config_info` |
    | `webhook_miss` | PR in scope but no webhook event arrived (webhook not registered?) | `config_fix` |
    | `unknown_pattern` | PR reviewed but reviewer assignment logged as skipped with unknown origin | `feature_request` |
    | `unsupported_agent` | PR authored by an AI agent crosscheck doesn't recognize | `feature_request` |

    **Config-fix recommendations:**
    - Each `config_fix` gap produces a specific, copy-pasteable suggestion:
      - `author_filtered`: "3 PRs from `dependabot[bot]` skipped — add to `allowed_authors` or switch to team mode."
      - `no_attribution`: "5 PRs from a human author had no attribution footer — add an `author_routes` entry to route them."
      - `no_reviewer`: "2 PRs detected as `codex`-origin but Codex is disabled — set `vendors.codex.enabled: true`."
    - `--apply` writes the suggested config changes directly to `crosscheck.config.yml` after confirmation.
    - `--issue` files the config gap as a best-practice issue to `motivation-labs/crosscheck` using the same `gh issue create` pipeline as `crosscheck issue`. Issue title: `config: [gap type] — best practice recommendation`. The issue describes the condition, the ideal config, and asks the maintainers to surface it in `crosscheck init` as a warning.

    **Feature-request recommendations:**
    - Each `feature_request` gap produces a structured feature proposal: problem statement, example missed PRs (sanitized), proposed detection logic, and estimated impact (N PRs/week that would be caught).
    - `--prd` clones `motivation-labs/crosscheck` to a temp dir, creates a feature branch, appends the proposal to `prd.md` under **Build Queue → 🔜 Next Up**, and opens a draft PR. PR body includes the sanitized gap data as supporting evidence.
    - `--build` goes further: after writing the prd.md entry, instructs the local AI agent (via `claude --print`) to implement the feature — creating the necessary source files, updating schema/config/tests — and pushes the implementation commits onto the same branch before opening the PR as ready-for-review.
    - Both `--prd` and `--build` require `gh auth status` to confirm the user has push access to the repo (or their fork). Falls back to `--dry-run` behavior if access check fails.

    **CLI interface:**
    ```bash
    crosscheck coverage                    # show gap report, no changes
    crosscheck coverage --apply            # apply config fixes after confirmation
    crosscheck coverage --issue            # file config gaps as best-practice issues
    crosscheck coverage --prd              # open a draft PR with prd.md feature proposal
    crosscheck coverage --build            # implement the feature and open a ready PR
    crosscheck coverage --since YYYY-MM-DD # limit analysis window
    crosscheck coverage --json             # structured JSON output
    ```

    **Sample output:**
    ```
    crosscheck coverage  (last 14 days · 71 PRs in scope)

      Coverage: 63 / 71 PRs reviewed  (89%)
      Missing:   8 PRs

      author_filtered    3 PRs  → add to allowed_authors or switch to team mode
        from: bot account (*[bot] pattern)  ×3

      no_attribution     3 PRs  → add author_routes to config
        from: human author (no Claude/Codex footer detected)  ×3

      unsupported_agent  2 PRs  → feature gap (GitHub Copilot attribution not recognized)
        from: copilot-swe-agent[bot]  ×2

    Config fixes available:
      Run  crosscheck coverage --apply   to apply the config fixes above.
      Run  crosscheck coverage --issue   to file best-practice issues for each config gap.

    Feature gaps available:
      Run  crosscheck coverage --prd     to propose attribution support for Copilot agents.
      Run  crosscheck coverage --build   to implement + open a PR to motivation-labs/crosscheck.
    ```

  - **Technical Notes:**
    - New file: `src/commands/coverage.ts`.
    - **Uptime computation:** scan log entries for `session_start` / `session_end` pairs; merge overlapping windows; the result is a list of `[start, end]` intervals. For `session_start` with no matching `session_end` (process killed), assume the window ended at the timestamp of the next non-session log entry.
    - **Scope enumeration:** GitHub has no `GET /orgs/{org}/pulls` endpoint and the pulls list API has no `since` filter. Use the Search API for org scopes: `GET /search/issues?q=type:pr+org:{org}+updated:>{since}&per_page=100` where `since` is the earliest analysis period boundary. Using `updated:>` (not `created:>`) ensures long-lived PRs opened before the window but updated during it are included, matching the "opened or updated during analysis period" requirement. For `config.users` entries, enumerate repos first via `listUserRepos` (already in `client.ts`) then query `GET /repos/{owner}/{repo}/pulls?state=all&per_page=100` per repo. For `config.repos`, query each repo directly the same way. Search API rate limit is 30 req/min authenticated — add a small delay between org queries if the user has many orgs.
    - **Log join:** a PR is "reviewed" if there is a `pr_received` log entry matching `owner/repo#number` AND a `review_complete` entry for the same key.
    - **Scope enumeration uses the full analysis period, not uptime windows.** The `since` parameter for Search/pulls queries is `max(--since flag, earliest session_start in logs)` — it covers everything crosscheck has ever been configured to watch, regardless of whether it was online. This ensures `offline_window` is reachable.
    - **Gap classification:** applied in priority order; first matching rule wins. `offline_window` fires when a PR is not in the reviewed set AND all of its `created_at`/`updated_at` timestamps fall outside every uptime window — meaning crosscheck simply wasn't running when the PR was active. PRs that overlap at least one uptime window but were still not reviewed proceed to the author/attribution/routing checks.
    - **Config apply:** uses `yaml.load` + `yaml.dump` pattern (same as `patchDeploymentConfig`). Shows a before/after diff and prompts `Apply? [y/N]` unless `--yes` is passed.
    - **Issue filing (`--issue`):** calls `gh issue create --repo motivation-labs/crosscheck` with a templated body. Body includes: gap type, frequency, ideal config, and a request to add a startup warning. No PR data included — only the gap pattern and config suggestion.
    - **PR contribution (`--prd`, `--build`):**
      1. `gh repo clone motivation-labs/crosscheck <tmpDir>` (or fork + clone if no push access).
      2. `git checkout -b feat/coverage-<gap-type>-<date>`.
      3. Append PRD entry to `prd.md` (or `--build`: generate and write source files).
      4. `git commit -m "feat: <gap type> — <one-line description>"`.
      5. `gh pr create --title "..." --body "..."` — draft PR for `--prd`, ready PR for `--build`.
    - Wire into `cli.ts` as `crosscheck coverage [--apply] [--issue] [--prd] [--build] [--since <date>] [--json] [-y/--yes]`.
    - Agent selection for `--build`: same `selectOptimizeAgent` logic. Prompt instructs the agent to implement only the specific detection pattern or config handling identified in the gap, not a full feature rewrite.
  - **Tests Required:**
    - Uptime window computation: two overlapping sessions → merged; unclosed session → window ends at next log entry timestamp.
    - Scope enumeration stub: given a mock GitHub API, returns correct PR list within uptime window.
    - Gap classification: `author_filtered` fires before `no_attribution`; `offline_window` fires when all of a PR's timestamps are outside uptime windows AND the PR is enumerated from the full analysis period (not pre-filtered to uptime windows).
    - `--apply` shows diff and writes correct YAML; is a no-op when `--yes` not passed and user declines.
    - `--issue` calls `gh issue create` with no PR identifiers or repo names in the body.
    - `--prd` clones repo, creates branch, appends to prd.md, opens draft PR.
    - `--json` output is valid JSON matching schema.
    - Coverage % calculated correctly: 0 reviewed → 0%; all reviewed → 100%.

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

- [x] **Fix `verdict: null` — handle Codex reviews that complete without a parseable verdict line** — when Codex finishes a review but its output contains no `VERDICT: APPROVE|NEEDS WORK|BLOCK` line, the current code logs `verdict: null` and posts the comment without a verdict badge. The missing verdict silently degrades the review experience and breaks downstream features (`diagnose` verdict counts, `impact` BLOCK metrics). This fix adds a fallback extraction pass, a warning comment annotation, and a structured log field so the failure is visible.
  - **User:** Anyone running `crosscheck watch`/`serve` with Codex as the reviewer — especially on large diffs where Codex may truncate or reformat output.
  - **Acceptance Criteria:**
    - Primary extraction: scan the full Codex output for the last line matching `/^VERDICT:\s*(APPROVE|NEEDS[_ ]WORK|BLOCK)/i`. Case-insensitive; tolerate `NEEDS_WORK` and `NEEDS WORK` spellings.
    - Fallback extraction: if the primary scan fails, scan for any line containing `APPROVE`, `NEEDS WORK`, `NEEDS_WORK`, or `BLOCK` as a standalone word (not mid-sentence). Use the last match.
    - If both scans fail, set verdict to `null`, prepend a warning line to the posted comment: `> ⚠️ crosscheck could not extract a verdict from this review. See the full output below.`, and log `{ event: 'verdict_parse_failed', reviewer: 'codex', output_length: N }` at `warn` level.
    - Verdict extraction logic is extracted into a pure function `parseVerdict(text: string): 'APPROVE' | 'NEEDS_WORK' | 'BLOCK' | null` in `src/lib/verdict.ts` — shared by `codex.ts` and `claude.ts`.
    - `crosscheck diagnose` counts `verdict_parse_failed` events as a distinct error pattern with a suggestion: "Codex did not emit a VERDICT line — check your Codex instructions file or lower the quality tier."
  - **Technical Notes:**
    - New file: `src/lib/verdict.ts` — `parseVerdict(text)`. Primary regex: `/^VERDICT:\s*(APPROVE|NEEDS[_ ]WORK|BLOCK)\s*$/im`. Fallback regex: `/\b(APPROVE|NEEDS[_ ]WORK|BLOCK)\b/gi` — last match wins.
    - `src/reviewers/codex.ts`: replace inline verdict parsing with `parseVerdict(output)`.
    - `src/reviewers/claude.ts`: same — also use `parseVerdict`.
    - `src/commands/watch.ts` / `review.ts`: when `verdict === null`, prepend the warning line to the comment body before posting; log `verdict_parse_failed`.
    - `src/lib/logger.ts`: add `verdict_parse_failed` to the known event union type.
  - **Tests Required:** `parseVerdict` with correct `VERDICT:` line → correct verdict; with `NEEDS_WORK` spelling → `NEEDS_WORK`; with verdict buried mid-paragraph (fallback) → correct; with no verdict → `null`; with multiple verdicts → last one wins; with `BLOCK` in a sentence ("this will not block deployment") → does not match.

- [ ] **Codex reviewer quality tier and model config** — the 5+ minute Codex review on large diffs (observed: 318s for PR #42 on o4-mini) is at the high end and blocks the watch terminal for the full duration. Expose `quality` and `model` as per-vendor config fields so users can trade review depth for speed.
  - **User:** Anyone running `crosscheck watch` who finds Codex reviews taking 3–6 minutes on large diffs.
  - **Acceptance Criteria:**
    - New config fields under `vendors.codex`:
      - `quality: 'low' | 'medium' | 'high'` — maps to Codex `--quality` flag; default `'medium'`.
      - `model: string | null` — passed as `--model <value>` to Codex; default `null` (uses Codex's own default). Only usable with API key auth; subscription auth ignores this field with a logged warning.
    - `crosscheck watch` banner `profile` row shows the active quality tier: `  profile  personal · watch · medium`.
    - `crosscheck status` shows `vendors.codex.quality` and `vendors.codex.model` (or `default` if unset).
    - `crosscheck.config.example.yml` documents both fields with comments explaining the speed/depth tradeoff.
    - `get-started.md` adds a **Review speed** section explaining quality tiers and when to use each.
  - **Technical Notes:**
    - `src/config/schema.ts`: add `quality: z.enum(['low', 'medium', 'high']).default('medium')` and `model: z.string().nullable().default(null)` to the `codex` vendor sub-schema.
    - `src/reviewers/codex.ts`: pass `--quality ${config.vendors.codex.quality}` to the Codex CLI call. If `model` is set, append `--model ${model}`; if `model` is set but auth is subscription-mode, log `warn: model override ignored — requires API key auth`.
    - `src/commands/watch.ts`: read `config.vendors.codex.quality` for the banner profile row.
    - `src/commands/status.ts`: add Codex quality and model to the vendor section.
  - **Tests Required:** schema defaults to `medium` quality and `null` model; `codex.ts` passes `--quality low` when configured; `--model` flag omitted when `model` is null; `--model` flag omitted with a warning when subscription auth is detected; banner shows configured quality tier.

- [ ] **Webhook re-registration flood on tunnel reconnect — deduplicate and back off** — when the smee/localhost.run tunnel drops and reconnects (new URL), `watch.ts` re-registers webhooks for all monitored repos. On a large org this produces a burst of GitHub API calls that can hit rate limits and fills the connectivity log with redundant entries. Add deduplication (skip re-registration if the webhook for a given URL is already registered) and exponential back-off for failed registrations.
  - **User:** Anyone monitoring large orgs (10+ repos) or experiencing frequent tunnel reconnects.
  - **Acceptance Criteria:**
    - Before registering a webhook for a repo/org, check whether a webhook pointing to the new tunnel URL is already registered via `GET /repos/{owner}/{repo}/hooks` (or org equivalent). If a matching hook exists, skip the `POST` and log `webhook already registered — skipped`.
    - After a tunnel reconnect, delete the old webhook (by stored hook ID) before registering the new one, rather than leaving orphaned hooks.
    - Failed webhook registrations are retried with exponential back-off: 2s → 4s → 8s → give up. Log each retry attempt at `warn` level. Do not block the main event loop — registration runs in background.
    - Connectivity log shows one summary line per tunnel reconnect event, not one line per repo: `  ✓ webhooks re-registered: 14/14 repos`.
    - `crosscheck status` shows the count of active (known) webhooks and their URLs.
  - **Technical Notes:**
    - `src/github/webhook.ts`: add `getExistingWebhook(owner, repo, url, token): Promise<number | null>` — returns hook ID if a hook with matching `config.url` exists, else null.
    - `src/commands/watch.ts`: store registered hook IDs in a `Map<string, number>` (key: `owner/repo` or `org`). On tunnel reconnect: 1) delete old hooks using stored IDs; 2) call `getExistingWebhook` for each scope; 3) skip `POST` if hook already exists (stale ID from a previous session). Retry loop: max 3 attempts with 2^n second delays.
    - Connectivity log: buffer all per-repo results and emit a single aggregated line.
    - `src/commands/status.ts`: show active webhook count.
  - **Tests Required:** `getExistingWebhook` returns hook ID when matching URL exists; returns null when no match; registration skipped when hook already exists; old hook deleted before new registration on reconnect; retry fires on 422 response with correct delays; aggregated log line shows correct count; status shows hook count.

- [ ] **`crosscheck onboard` — Guided Persona Setup and Smart Scope Configuration** — an interactive wizard that runs all `init` environment checks and then guides the user through persona selection, repo/org scope picking, author filtering, workflow depth, and optional comment branding. Produces a complete, working `crosscheck.config.yml` without manual YAML editing. Supersedes the minimal first-run prompts in `watch`/`serve` as the recommended entry point for new users.

  **The deployment scenarios this command covers:**

  | ID | Name | Core need |
  |---|---|---|
  | UC-01 | Personal — curated repos | Personal + org accounts; building personal projects; wants to limit monitoring to a hand-picked set of active repos (backtracing feature requires tight scope) |
  | UC-02 | Personal — cross-scope, author-filtered | Monitors both personal and org repos but only wants their own PRs reviewed |
  | UC-03 | Team shared CR | Each member uses local Claude Code to author PRs; team shares a Codex account for review; configurable depth: CR-only vs CR + auto-fix |
  | UC-04 | CRaaS / branded service | Any of the above, plus custom service name and comment annotations; available as an optional add-on at the end of any onboarding path |

  **Command:** `crosscheck onboard [--reconfigure]`

  ---

  **Step 0 — Environment checks (same as `crosscheck init`, compact output):**

  Re-use `runChecks()` from `init.ts`. Print a compact one-line-per-tool summary. Non-fatal failures (e.g., codex CLI not installed) show the fix hint and continue — `onboard` never aborts because a reviewer CLI is missing. Print `  ✓ environment ready — proceeding to setup` or `  ⚠ 1 issue to address — see above; continuing setup` before advancing to Step 1.

  ---

  **Step 1 — Persona selection:**

  ```
  How will you use crosscheck?

    [1] personal  — I author PRs; review only my own work across my repos and orgs
    [2] team      — shared CR workflow; review PRs from multiple authors in org repos

  Choice [1]:
  ```

  ---

  **Personal path (UC-01 and UC-02):**

  Step 2 — Monitoring scope (auto-detect org memberships before showing):
  ```
  What should crosscheck monitor?  (detected: member of my-company, another-org)

    [1] My personal repos only     — github.com/beingzy/* — side projects and tools you own directly
    [2] My org repos only          — github.com/my-company/*, another-org/* — team repos you contribute to
    [3] Both personal repos + orgs — everything across your GitHub account  ← recommended

  Choice [3]:
  ```

  Step 3 — Repo picker (shown only when personal repos are in scope):

  Fetch `GET /users/{login}/repos?type=owner&sort=pushed&per_page=100`. Partition into three tiers:
  - **Tier 1 — New repos** (created within last 7 days): shown first in the primary list, tagged `new`, pre-selected. A newly-created repo signals active intent even before its first PR lands — missing it would frustrate the user immediately.
  - **Tier 2 — Active repos** (≥ 1 PR in last 90 days): sorted by PR count descending.
  - **Tier 3 — Inactive repos** (no PRs in 90 days, not new): deferred behind `[ ] Show more`.

  Primary list shows all Tier-1 repos + top Tier-2 repos up to a combined cap of 8. A `[ ] Show more` row expands inline to all Tier-2 + Tier-3 repos. Repos with zero PRs in 180 days that are not new are omitted entirely and noted: "add manually to config.repos if needed."

  ```
  Which personal repos should crosscheck monitor?

    [x] beingzy/new-side-project   (new · 0 PRs)
    [x] beingzy/api-service        18 PRs (last 90 days)
    [x] beingzy/cool-project       12 PRs
    [ ] beingzy/dashboard           3 PRs
    [ ] beingzy/old-tool            1 PR
        ────────────────────────────────────────────────
    [ ] Show more  (3 repos with no recent activity — or add to config.yml manually)

  Space to toggle · Enter to confirm
  ```

  Step 4 — Author filter:
  ```
  Whose PRs should be reviewed?

    [1] Only mine  (author = beingzy)    ← recommended for UC-02
    [2] Everyone in the monitored scope

  Choice [1]:
  ```

  Config written by personal path:
  - UC-01 (curated personal repos): `deployment: personal`, `repos: [selected]`, `users: []`, `orgs: []`, `allowed_authors: [login]`
  - UC-02 (both scopes, author-filtered): `deployment: personal`, `users: [login]`, `orgs: [detected]`, `allowed_authors: [login]`
  - Personal + everyone: `deployment: personal`, `users: [login]`, `orgs: [detected]`, `allowed_authors: []`

  ---

  **Team path (UC-03):**

  Step 2 — Org selection (auto-detect memberships via `GET /user/memberships/orgs?state=active`):
  ```
  Which orgs should crosscheck monitor?

    [x] my-company           (member · 42 repos)
    [ ] open-source-project  (member ·  7 repos)

  Space to toggle · Enter to confirm
  ```

  Step 3 — Author filter:
  ```
  Whose PRs should be reviewed?

    [1] All authors (no filter) — review every PR in the org
    [2] Specific GitHub logins  — restrict to listed team members

  Choice [1]:
  ```
  If [2]: `  Enter logins (comma-separated): john, jane, alice`

  Step 4 — Review depth:
  ```
  How deep should the CR workflow go?

    [1] CR only       — post review comments; humans apply fixes
    [2] CR + Auto-fix — crosscheck also proposes and commits fixes

  Choice [1]:
  ```
  If [2]:
  ```
  How should auto-fixes be delivered?

    [1] Open a fix PR  (human reviews and merges before merge)   ← recommended
    [2] Push directly onto the PR branch

  Choice [1]:
  ```

  Config written by team path (CR + fix PR example):
  `deployment: team`, `orgs: [selected]`, `users: []`, `allowed_authors: [logins or []]`, `post_review.auto_fix.enabled: true`, `post_review.auto_fix.delivery.mode: pull_request`

  ---

  **Optional — Custom comment branding (available for all personas, including UC-04 CRaaS):**

  After the persona-specific questions complete, all paths ask one optional step:

  ```
  Add custom branding to review comments? (for teams, services, or personal flair) [y/N]:
  ```

  If yes:
  ```
  Name or label shown in every review comment:
  > My Team

  Comment header (prepended to every review, Enter to skip):
  > [Enter]

  Comment footer (appended to every review, Enter to skip):
  > Code review powered by My Team · AI-assisted, human-approved.

  Reviewer attribution line (replaces "Reviewed by {vendor}", Enter to skip):
  > [Enter]
  ```

  Branding is lightweight for personal users (e.g., a footer with a link) and richer for CRaaS operators (service name + attribution + footer). All fields are optional and independently skippable. Saved to the `brand` config section; comment format unchanged when all fields are empty.

  ---

  **Confirmation preview and write:**

  After all steps, show a compact summary and prompt before writing:
  ```
    Your crosscheck config:

      persona      personal
      scope        repos (beingzy/api-service, beingzy/cool-project) + orgs (my-company)
      filter       author = beingzy
      reviewer     cross-vendor (claude ↔ codex)
      config       ~/.crosscheck/config.yml

  Write config? [Y/n]:
  ```
  On confirm: write config, print `  ✓ config written — run  crosscheck watch  to start`.
  On decline: print `  Cancelled. No files written.` and exit 0.

  **`--reconfigure` flag:** Re-runs all steps even if config already exists. Shows the current saved value as the default at each prompt. Useful when joining a new org, switching personas, or correcting a first-run mistake.

  ---

  **New config schema — `brand` section (available to all personas):**

  ```typescript
  export const BrandConfigSchema = z.object({
    service_name: z.string().default('crosscheck'),
    comment_header: z.string().default(''),
    comment_footer: z.string().default(''),
    reviewer_attribution: z.string().default(''),
  })
  ```
  Added to `ConfigSchema` as `brand: BrandConfigSchema.default({})`.

  Both `claude.ts` and `codex.ts` apply `config.brand` when composing the GitHub comment:
  - Non-empty `brand.comment_header` → prepend to comment (followed by a blank line).
  - Non-empty `brand.comment_footer` → append to comment (preceded by a blank line).
  - Non-empty `brand.reviewer_attribution` → replace the default `> Reviewed by {vendor}` attribution line.
  - When all `brand` fields are empty (the default), comment format is unchanged.

  ---

  **Relationship to existing commands:**

  - `crosscheck init` remains unchanged — environment check only. `onboard` calls `runChecks()` internally as Step 0. `init` is for diagnosing environment issues; `onboard` is for first-time configuration.
  - The minimal first-run prompts in `watch`/`serve` (from the Deployment Mode spec) remain as a lightweight fallback for users who skip `onboard`. They show a binary `personal`/`team` choice without repo picking or brand customization.
  - `crosscheck init` output adds a one-line hint: `Run  crosscheck onboard  to configure scope and persona.`
  - `crosscheck status` shows a `persona` row with the deployment value (or `service` when `brand.service_name` is non-default) and `brand.service_name` when set.

  ---

  - **User:** New crosscheck users of any persona — solo developers building side projects, teams running shared CR pipelines, and anyone (personal or team) who wants light or rich comment branding.
  - **Acceptance Criteria:**
    - `crosscheck onboard` runs environment checks first and prints a compact one-line-per-tool summary.
    - Persona question is always shown with two choices (personal / team); no third "service" option — branding is an optional add-on step for all paths.
    - Personal path: scope (with per-option descriptions) → repo picker (when personal repos in scope) → author filter → optional branding → correct config for UC-01, UC-02, and the unrestricted variant.
    - Team path: org picker → author filter → review depth → (if auto-fix) delivery mode (fix PR or direct push only — no inline-suggestion option) → optional branding → correct config for UC-03.
    - Repo picker: Tier-1 new repos (< 7 days) shown first and pre-selected; Tier-2 active repos (≥ 1 PR last 90 days) sorted by count; Tier-3 inactive repos behind "Show more"; repos absent from both tiers for 180+ days noted as "add manually."
    - Branding step is optional (`[y/N]`, default N); if yes, shows 4 fields each independently skippable.
    - Confirmation preview accurately reflects all choices before writing.
    - `--reconfigure` re-runs all steps with current config values pre-filled as defaults; overwrites on confirm; exits without writing on decline.
    - `brand` fields injected into GitHub comments by both `claude.ts` and `codex.ts` when non-empty; comment format unchanged when all `brand` fields are empty.
    - `crosscheck status` shows `persona` row and `brand.service_name` when non-default.
    - `crosscheck init` output includes the onboard hint line.
    - Running `onboard` twice produces identical config (no duplicate entries).
    - `onboard` with environment check failures still completes all questions and writes config; it does not abort.
  - **Technical Notes:**
    - New file: `src/commands/onboard.ts`. Imports `runChecks` from `init.ts`. Drives persona branching. Branding step runs for all paths after persona-specific questions. At the end, calls `patchDeploymentConfig` + `patchBrandConfig` to write all config values atomically.
    - New file: `src/lib/repo-picker.ts`: `fetchActiveRepos(login: string, token: string): Promise<{ tier: 1 | 2 | 3; repo: string; prCount: number; createdAt: Date }[]>` — GitHub API calls, three-tier partition; `promptRepoPicker(repos, defaults?)` — readline-based checkbox UI showing Tier 1 + Tier 2 up to 8 combined, "Show more" expands Tier 3; no new prompt-library dependency.
    - `src/config/schema.ts`: add `BrandConfigSchema` and `brand: BrandConfigSchema.default({})` to `ConfigSchema`.
    - `src/config/loader.ts`: add `patchBrandConfig(configPath: string, brand: Partial<BrandConfig>): boolean`.
    - `src/reviewers/claude.ts`: inject `brand.comment_header` / `comment_footer` / `reviewer_attribution` when composing the final comment string; no-op when all empty.
    - `src/reviewers/codex.ts`: same injection logic.
    - `src/commands/status.ts`: add `persona` row showing deployment + `brand.service_name` when non-default.
    - `src/commands/init.ts`: append hint line at the end of output.
    - Wire into `cli.ts` as `crosscheck onboard [--reconfigure]`.
    - `crosscheck.config.example.yml`: add commented `brand:` block with all four fields.
    - `get-started.md`: add **First-time setup** section with each UC described in 2–3 sentences.
  - **Tests Required:**
    - `fetchActiveRepos`: repos < 7 days old in Tier 1 regardless of PR count; repos ≥ 1 PR in last 90 days in Tier 2 sorted by count; zero-PR repos older than 7 days in Tier 3; returns `[]` gracefully when GitHub returns nothing.
    - `promptRepoPicker`: Tier-1 repos shown first and pre-selected; Tier-2 shown next up to cap; "Show more" expands Tier-3 inline; returns correct selection array.
    - Personal + both scopes + author-mine → `{ deployment: 'personal', users: [login], orgs: [...], allowed_authors: [login] }`.
    - Personal + personal-only + 2 repos selected → `{ deployment: 'personal', repos: [r1, r2], users: [], orgs: [], allowed_authors: [login] }`.
    - Team + all-authors + CR-only → `{ deployment: 'team', allowed_authors: [], post_review: { auto_fix: { enabled: false } } }`.
    - Team + specific logins + CR + fix-PR → `{ deployment: 'team', allowed_authors: ['john', 'jane'], post_review: { auto_fix: { enabled: true, delivery: { mode: 'pull_request' } } } }`.
    - Branding opt-in → `brand.service_name`, `brand.comment_footer` written; skipped fields remain empty string.
    - Branding opt-out (default N) → no `brand` fields written (all remain at schema defaults).
    - `claude.ts` with non-empty `brand.comment_header` → header prepended to posted comment.
    - `claude.ts` with empty `brand` fields → comment format unchanged.
    - `patchBrandConfig` writes correctly; idempotent on second run.
    - `--reconfigure` re-prompts with current values as defaults; overwrites on confirm; no-ops on decline.
    - `crosscheck status` shows `persona` row.
    - `crosscheck init` output includes hint line.

- [ ] **Arrow-key + space interactive picker — replace number-toggle UI in `onboard`** — the org and repo selection steps in `crosscheck onboard` use a raw-mode TTY picker with arrow-key navigation and space-to-toggle, matching the UX of standard CLI tools (`inquirer`, `fzf`). Closes [issue #58](https://github.com/Motivation-Labs/crosscheck/issues/58).
  - **User:** Anyone running `crosscheck onboard` who needs to select repos without memorizing item numbers.
  - **Acceptance Criteria:**
    - **↑ / ↓ arrows** — move the highlight cursor between items; wraps at top and bottom.
    - **Space** — toggle the focused item on/off (`[x]` / `[ ]`).
    - **Enter** — confirm the current selection and return.
    - **a** — select all / deselect all (toggles entire visible set).
    - Items are rendered as `  [x] owner/repo-name` with the focused row highlighted (bold or reverse-video ANSI).
    - 3-tier overflow: show at most 15 items at a time; pressing `m` (or the overflow hint key) expands to show all. Cursor wraps within the visible set.
    - A status line below the list shows `  ↑↓ move · space select · a all · enter confirm · m more`.
    - Rendering uses ANSI escape codes to re-render only changed lines (no full-screen flicker, no `readline` loop).
    - Degrades gracefully when `process.stdin.isTTY` is false: skip picker, return an empty selection (caller prints a manual-edit hint).
  - **Technical Notes:**
    - New file: `src/lib/repo-picker.ts` — exports `promptRepoPicker(items: string[], opts?: { title?: string }): Promise<string[]>`. Internally calls `process.stdin.setRawMode(true)`, intercepts raw key bytes, re-renders on each keypress, restores stdin on return/exit.
    - Key byte detection: `\x1b[A` = up arrow, `\x1b[B` = down arrow, `\x20` = space, `\x0d` = enter, `\x61` = `a`, `\x6d` = `m`.
    - On SIGINT while picker is active: restore raw mode and re-throw so the process exits cleanly.
    - No new runtime dependencies — raw-mode TTY and ANSI escapes are stdlib-level on Node.js.
  - **Tests Required:** `promptRepoPicker` with non-TTY stdin returns empty array; up/down moves cursor correctly; space toggles item; enter returns selected items; `a` selects all when none selected, deselects all when all selected; overflow hint shown when items > 15; cursor wraps at list boundaries; SIGINT restores raw mode.

- [ ] **`--no-backtrace` flag for `watch` and `serve`** — add a session-only CLI flag that skips the initial scan for unreviewed open PRs, without requiring a config edit. Useful when restarting `watch` frequently (e.g., during config iteration) where the startup scan adds latency.
  - **User:** Any developer who restarts `crosscheck watch` repeatedly and finds the backtrace scan slow or redundant.
  - **Acceptance Criteria:**
    - `crosscheck watch --no-backtrace` and `crosscheck serve --no-backtrace` skip the `scanUnreviewedPRs` call entirely for that session.
    - Config is not read or written — `backtrace.enabled` in `crosscheck.config.yml` is unaffected.
    - The connectivity log shows `  backtrace skipped (--no-backtrace flag)` in place of the scan summary when the flag is passed.
    - `crosscheck watch --no-backtrace` is equivalent to `crosscheck watch` when `backtrace.enabled: false` is in config — same code path, different trigger.
    - `--no-backtrace` is independent of `--personal`, `--team`, and `--reconfigure` (all flags can be combined).
  - **Technical Notes:**
    - `src/cli.ts`: add `.option('--no-backtrace', 'skip the startup scan for unreviewed open PRs this session')` to both `watch` and `serve` command definitions. Commander maps `--no-backtrace` to `opts.backtrace === false`.
    - `src/commands/watch.ts` / `serve.ts`: in the backtrace block, change the condition from `if (config.backtrace.enabled)` to `if (config.backtrace.enabled && opts.backtrace !== false)`. Pass `opts` through the existing opts parameter.
    - Log the skip message via `cLog` (watch) / `board.log` (serve) so it's visible in the connectivity section.
  - **Tests Required:** `--no-backtrace` flag parsed correctly; backtrace block skipped when flag is true; `config.backtrace.enabled: false` still skips regardless of flag; `config.backtrace.enabled: true` without flag runs scan normally; log message emitted when flag skips the scan.

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

#### Custom Workflow Engine (`workflow.yml`)

**Problem:** crosscheck is a passive reviewer — it posts a comment and stops. The review → fix → re-review cycle is repetitive for formulaic issues (lint violations, missing tests, doc gaps). There is also no way to customize the pipeline shape per repo: some teams want review-only, others want auto-fix on NEEDS_WORK, others want a full review → address → recheck loop.

**Value:**
1. **Closes the feedback loop** — from "AI posts comment" to "AI posts comment + attempts fixes + re-reviews." The PR author gets a clean diff rather than a list of action items.
2. **Pipeline composition without code changes** — teams define multi-step workflows in a checked-in YAML file. crosscheck executes the steps.
3. **Behavior steering per step** — the `review` step and the `address` step need different instructions. A reviewer should be skeptical; an agent fixing its own comments should be conservative and scoped.
4. **Progressive adoption** — users can start with the default `[review]` pipeline and add `address` when they're ready. No new concepts forced on existing users.

**Design — `workflow.yml`:**

Placed at `.crosscheck/workflow.yml` or `crosscheck.workflow.yml` in the repo. Falls back to a default single-step `review` pipeline if absent (fully backwards compatible).

```yaml
# .crosscheck/workflow.yml

on:
  - opened
  - synchronize          # new commits pushed to an existing PR

steps:
  - name: review
    type: review
    reviewer: auto        # auto = cross-vendor logic from config.mode

  - name: address
    type: address
    when: "verdict == 'NEEDS_WORK'"
    reviewer: auto
    max_rounds: 2
    instructions: |
      Only address comments that are explicitly called out in the review.
      Do not refactor logic, rename identifiers, or add tests.
      Do not touch files the review did not mention.
      If a comment requires understanding of business logic, skip it and leave a note.

  - name: recheck
    type: review
    when: "address.applied_count > 0"
    reviewer: auto
```

**Step types:**

| Type | What it does |
|---|---|
| `review` | Runs the AI reviewer, posts a comment with verdict |
| `address` | Reads the review comment, opens a commit on the PR branch with fixes |
| `recheck` | Re-runs review on the updated branch (same as `review` but semantically distinct) |
| `notify` | Sends a notification — Slack, email (future) |

**Step fields:**

| Field | Required | Description |
|---|---|---|
| `name` | yes | Identifier used in `when` conditions |
| `type` | yes | `review`, `address`, `recheck`, `notify` |
| `reviewer` | no | `auto`, `claude`, `codex` — overrides config for this step |
| `when` | no | Boolean expression; step skipped if false. Context vars: `verdict`, `<step-name>.applied_count`, `<step-name>.verdict` |
| `max_rounds` | no | Caps iterations for `address` steps (default 1) |
| `instructions` | no | Prose appended to the AI prompt for this step only — overrides global `instructions.md` for this step |

**Behavior steering — `instructions` block:**

The per-step `instructions` field is the primary knob for steering AI behavior within the pipeline. It is appended to the prompt for that step only. Global `~/.crosscheck/instructions.md` still applies as a base layer; step-level `instructions` extend or override it.

This lets teams express policies like:
- "During `address`, never touch tests or migrations."
- "During `recheck`, be stricter about security than the initial review."
- "During `address`, prefer one-line fixes — no multi-function refactors."

**Safeguards (non-negotiable defaults):**

- `max_rounds: 1` default on all `address` steps — prevents loops
- `auto_merge: false` always — address creates commits, never merges
- `address` only touches files mentioned in the review comment it is addressing
- Every `address` commit message begins `[crosscheck]` for traceability and easy revert
- Hard limit: no `address` step runs if the PR already has > N `[crosscheck]` commits (configurable, default 5)

**Relationship to existing config files:**

| File | Owns |
|---|---|
| `crosscheck.config.yml` | Infrastructure: mode, repos, orgs, vendors, budget, server |
| `.crosscheck/workflow.yml` | Pipeline shape: step order, types, conditions, max_rounds |
| `~/.crosscheck/instructions.md` | Global prose behavior for all review steps |
| Step-level `instructions:` | Per-step behavior overrides within `workflow.yml` |

**Default workflow — constant, not a file:**

```typescript
// src/lib/workflow.ts
export const DEFAULT_WORKFLOW: WorkflowStep[] = [
  { name: 'review', type: 'review', reviewer: 'auto' }
]

export function loadWorkflow(repoDir: string, configDir: string): WorkflowStep[] {
  const file = findWorkflowFile(repoDir, configDir)
  if (!file) return DEFAULT_WORKFLOW
  return parseWorkflowFile(file)  // Zod-validated, throws on schema error
}
```

`watch.ts`/`serve.ts` always call `loadWorkflow` + `runWorkflow`. No conditional for "no file". The constant *is* the backwards compatibility — existing installs without a `workflow.yml` get the default single-step behavior through the same code path as custom workflows.

**`crosscheck init` generates a workflow template:**

```yaml
# .crosscheck/workflow.yml — generated by crosscheck init

on:
  - opened
  - synchronize

steps:
  - name: review
    type: review
    reviewer: auto

  # Uncomment to enable auto-fix after review:
  # - name: address
  #   type: address
  #   when: "verdict == 'NEEDS_WORK'"
  #   max_rounds: 2
  #   instructions: |
  #     Only fix what the review explicitly calls out.
  #     Do not refactor logic or add tests.

  # - name: recheck
  #   type: review
  #   when: "address.applied_count > 0"
```

New users see the full capability surface immediately. The template is the documentation.

**Implementation notes:**
- New file: `src/lib/workflow.ts` — `DEFAULT_WORKFLOW` constant; Zod schema; `loadWorkflow(repoDir, configDir)`.
- New file: `src/lib/runner.ts` — `runWorkflow(steps, context)` — iterates steps, evaluates `when`, dispatches handlers.
- `watch.ts` / `serve.ts`: replace direct reviewer call with `loadWorkflow(tmpDir, configDir)` + `runWorkflow(steps, context)` — unconditional, no legacy branch.
- `address` handler: read the crosscheck review comment, pass it + diff + step `instructions` to AI, parse file patches from response, apply via `git apply`, push `[crosscheck] address: ...` commit.
- `when` evaluation: flat context object, equality + numeric comparison operators only — no scripting engine.
- `init.ts`: write `.crosscheck/workflow.yml` template; skip silently if file already exists.

**Open questions before implementation:**
- Should `address` push commits directly to the PR branch (requires write access) or open a follow-up PR? Direct commits are simpler; follow-up PRs are safer for external contributors. Default to direct commits on branches the token owns; follow-up PR on forks.
- Should `when` support `AND`/`OR` or keep it to single conditions? Start with single conditions — composable via multiple steps.

---

#### `crosscheck issue` — AI-drafted bug reports from logs

**Problem:** when crosscheck fails silently or behaves unexpectedly, users have to manually dig through `~/.crosscheck/logs/`, identify the error, understand its context, write a coherent issue, and decide what details matter. That friction means failures go unreported.

**Solution:** `crosscheck issue` does the digging automatically. It reads recent logs, surfaces the most relevant failure, drives a short multiple-choice interview to fill context gaps, and hands the whole package to the local AI agent to write a well-structured issue draft. The user just reads, answers three quick questions, and hits `y`.

**Flow:**

```
$ crosscheck issue

  scanning logs...
  found 3 error patterns in the last 3 days:

  [1] command_not_found: tsc  (4 occurrences)
  [2] base_branch_missing      (1 occurrence)
  [3] timeout                  (1 occurrence)

  Which issue do you want to report? [1-3]: 1

  drafting issue with claude...

  ┌─────────────────────────────────────────────────────────────────────┐
  │ TITLE: codex reviewer fails when repo has a tsc build step          │
  ├─────────────────────────────────────────────────────────────────────┤
  │ ## Description                                                      │
  │ The codex reviewer exits with `command_not_found: tsc` on repos     │
  │ that include a TypeScript build step...                             │
  │                                                                     │
  │ ## Steps to Reproduce                                               │
  │ 1. Run `crosscheck watch` on a TypeScript repo                     │
  │ 2. Open a PR — codex reviewer is triggered                         │
  │ 3. Review fails with `Error: command not found: tsc`               │
  │                                                                     │
  │ ## Log Excerpt                                                      │
  │ ```                                                                 │
  │ {"ts":"...","event":"error","reviewer":"codex","error":             │
  │  "command_not_found","command":"tsc","repo":"[repo]"}               │
  │ ```                                                                 │
  │                                                                     │
  │ ## Environment                                                      │
  │ - crosscheck: 0.2.1                                                 │
  │ - platform: darwin                                                  │
  │ - reviewer: codex                                                   │
  │ - mode: cross-vendor                                                │
  └─────────────────────────────────────────────────────────────────────┘

  Can you reproduce this consistently?
  [1] Every time  [2] Sometimes  [3] Happened once
  > 1

  Which command triggered this?
  [1] watch  [2] serve  [3] review  [4] Unknown
  > 1

  Is this blocking you from using crosscheck?
  [1] Blocked  [2] Degraded  [3] Cosmetic
  > 2

  Submit to motivation-labs/crosscheck? [y/N]: y

  ✓ issue created → https://github.com/motivation-labs/crosscheck/issues/47
```

**Agent selection:** same `selectOptimizeAgent` logic as `optimize` — picks the vendor with the higher success rate from recent logs; falls back to claude on a tie or no data.

**Sanitization:** applied before sending log entries to the AI agent and before posting. Patterns stripped: `owner/repo` (→ `[repo]`), PR titles, file paths, GitHub usernames, branch names, GitHub URLs. Secrets never appear in logs (enforced at write time by `logger.ts`).

**`--dry-run` use case:** teams who want to review the draft before reporting, or who want to template-match issues for a triage queue without posting immediately.

**`--yes` use case:** automated pipelines (e.g., a cron that calls `crosscheck issue --yes` nightly and files anything new). Still shows the draft in stdout so CI logs are auditable.

**Relationship to `diagnose`:**

`diagnose` is a reporting tool — it reads logs and surfaces patterns for the operator. `issue` is an action tool — it takes the same patterns and turns them into a GitHub ticket. Both share the same error-grouping logic via `src/lib/log-analysis.ts`.

**File layout additions:**

```
src/
  commands/
    issue.ts           ← crosscheck issue command
  lib/
    log-analysis.ts    ← shared error-grouping logic (extracted from diagnose.ts)
#### `crosscheck impact` — value dashboard

**Problem:** crosscheck runs in the background and reviews PRs silently. After a few weeks, users have no concrete sense of what it has saved them — so they can't justify the setup cost, can't calibrate the tool, and can't communicate its value to their team.

**Value proposition of this feature:** Turn passive automation logs into a human-readable ROI summary. The answer to "is crosscheck worth it?" should be one command away.

---

**Time-saving calculation:**

The core unit is *time saved per PR* = `assumed_human_review_min − actual_ai_review_min`.

```
assumed_human_review_min  → configurable, default 60
actual_ai_review_min      → avg(review_complete.duration_ms) / 60000 from logs; fallback 2 min
time_saved_per_pr         → assumed − actual  (≈ 58 min at defaults)
total_hours_saved         → (time_saved_per_pr × prs_reviewed) / 60
```

**Basis for the 60-minute default:**
- Google's Engineering Productivity research: median PR review latency 60–90 min for non-trivial changes when factoring in reviewer availability.
- GitHub Octokit 2023: developers spend ~15–20% of time on code review; for a 40h week that's 6–8 hours, typically covering 4–6 PRs → 60–90 min per PR average.
- Microsoft Research SPACE framework: "review overhead" tracked as 30–120 min depending on PR size; 60 min is the lower-bound safe default.

The displayed assumption line keeps the model transparent. Users with smaller/larger PRs can calibrate.

---

**Issues-caught calculation:**

```
issues_caught    = NEEDS_WORK_count + BLOCK_count
block_count      = BLOCK verdicts (surfaced separately — higher severity)
issue_rate       = issues_caught / prs_reviewed
```

These are PRs that received actionable feedback. Without crosscheck, that feedback would not exist (cross-vendor review only happens because crosscheck ran).

---

**Defect cost model (opt-in via `--money`):**

```
estimated_value = (hours_saved × hourly_rate)
                + (issues_caught × defect_cost_per_issue)

defaults:
  hourly_rate         = $150 USD (US mid-senior engineer)
  defect_cost         = $150 USD (1 hr to fix, same rate)
```

**Basis for defect cost:**
- NIST 2002 report: cost to fix a defect grows 4–10× from review to production. At $150/hr and a 1-hour median fix, a defect caught in review saves $150 (fix during PR) vs $600–$1,500 (fix post-merge). Using $150 is maximally conservative — it only counts the direct fix cost, not downstream cost.
- IBM Systems Sciences Institute: software bugs found in production cost 6–15× more than during development. Same conservative logic applies.

The `--money` flag is opt-in so the output doesn't over-claim in contexts where monetary framing is inappropriate (open-source, student projects, etc.).

---

**Second-order code quality signal:**

The BLOCK rate trend (BLOCK verdicts / total PRs, by week) is a leading indicator of upstream quality improvement:

- Declining BLOCK rate: teams are internalizing review feedback; fewer high-severity issues reach PR stage.
- Stable BLOCK rate: issues persist — potential input for `crosscheck optimize` to tighten review instructions.
- Rising BLOCK rate: either more complex PRs or a genuine quality regression.

This is presented as a trend, not a judgment, with a note that it is a proxy metric.

---

**Sample output:**

```
crosscheck impact  (all time · 63 PRs)

  Time saved
  ─────────────────────────────────────────
  PRs reviewed          63
  Avg AI review time    1.8 min
  Assumed human time    60 min  ⓘ
  Time saved per PR     ~58 min
  Total hours saved     ~61 h

  Issues caught
  ─────────────────────────────────────────
  APPROVE               41  (65%)
  NEEDS WORK            17  (27%)   ← actionable feedback
  BLOCK                  5   (8%)   ← potential bugs/breaking changes caught before merge
  Total issues caught   22

  Code quality trend  (BLOCK rate, weekly)
  ─────────────────────────────────────────
  Apr W1  ██████  12%
  Apr W2  ████    8%
  Apr W3  ███     6%
  Apr W4  ██      4%   ↓ improving

  ⓘ assumes 60 min avg human review — set impact.assumed_human_review_minutes to adjust
  Run `crosscheck impact --money` for a rough monetary estimate.
```

With `--money`:
```
  Estimated value
  ─────────────────────────────────────────
  Time savings          ~$9,150  (61h × $150/hr)
  Issues prevented      ~$3,300  (22 × $150/issue)
  Total estimate        ~$12,450

  ⚠ rough estimate · adjust rates in crosscheck.config.yml · not accounting data
```

---

#### Auto-init on `watch`/`serve`

**Problem:** the current flow requires `crosscheck init` before `crosscheck watch`. This is undiscoverable — most users will try `watch` first, hit a missing-config or missing-secret error, and not know why. `init` as a prerequisite is friction that blocks the happy path.

**Solution:** `watch` and `serve` call `ensureInit` at startup. If setup has already been done, it's a no-op. If not, it runs the missing steps inline and continues. `crosscheck init` stays as an explicit command for verification and re-runs, but it is no longer required.

**Detection — sentinel file, one check per startup:**

After a successful init, `ensureInit` writes `~/.crosscheck/.initialized` containing the current crosscheck version (e.g., `0.2.0`). On every subsequent `watch`/`serve` start, the sentinel is checked first. If it exists and the version matches, the global setup step (webhook secret) is skipped. However, the two repo-local files (`crosscheck.config.yml`, `.crosscheck/workflow.yml`) are always checked via cheap `existsSync` calls — if either is absent, it is created before proceeding. This means the cost is O(1) `existsSync` calls per startup after the first run, not a full re-init, but each repo gets its local files regardless of whether another repo was initialized first.

The subprocess-heavy checks (gh, claude, codex auth) are never run by `ensureInit` — they remain in `crosscheck init` only.

```
First run:   check sentinel → absent → run all setup steps → write sentinel → continue
Subsequent:  check sentinel → present + version matches → skip webhook secret → check repo-local files → create any missing → continue
Upgrade:     check sentinel → version mismatch → re-run changed steps → update sentinel → continue
New repo:    check sentinel → present + version matches → repo-local files absent → create them → continue
```

`crosscheck init` always runs the full check and rewrites the sentinel regardless — explicit verification is its job. Already-present files are never overwritten by auto-init.

**Terminal output on first run:**

```
  ✦ first run — setting up crosscheck...
  ✓ webhook secret generated → ~/.crosscheck/webhook-secret
  ✓ config written → crosscheck.config.yml
  ✓ workflow written → .crosscheck/workflow.yml

crosscheck watch
  repos   acme/api
  ...
```

Silent on subsequent runs. Auth checks (missing gh, claude, codex CLIs) are not run here — run `crosscheck init` explicitly to see full auth status.

**Implementation:**
- New file: `src/lib/setup.ts` — `ensureInit(cwd, opts?)`: checks sentinel first; if present and version matches, skips the webhook-secret step but still runs `existsSync` on the two repo-local files and creates any that are missing; if sentinel is absent or version differs, runs all setup steps and writes `~/.crosscheck/.initialized`. Returns `{ created: string[] }`. Never spawns a subprocess.
- Sentinel file: `~/.crosscheck/.initialized` — plain text, contains semver string (e.g., `0.2.0`). Version compared against `pkg.version` at runtime. On mismatch, only the steps that changed between versions are re-run.
- `init.ts` refactored: extracts setup steps into `setup.ts`; becomes a thin wrapper that calls `ensureInit` with `{ force: true, verbose: true }` (bypasses sentinel) then prints the full status table.
- `watch.ts` / `serve.ts`: `await ensureInit(process.cwd())` before `loadConfig`. `--no-init` flag skips the call entirely for CI/provisioned environments where setup is pre-baked.

---

#### smee.io tunnel backend for `crosscheck watch`

**Problem:** `localhost.run` SSH tunnels silently go dead (HTTP 503) without the SSH process exiting. `watch` stays stuck waiting for an SSH exit event, so all webhook events are dropped until the user manually restarts. Root-cause observation: PR #27 received no review because the tunnel died between 03:40 and 03:49 UTC while `watch` was running.

**Solution:** add `tunnel.backend: smee` as an opt-in alternative. The smee.io relay queues events while the local client is offline and replays them on reconnect — eliminating the missed-event class of failure entirely.

**Design decisions:**

| | localhost.run (default) | smee.io |
|---|---|---|
| Install | none (ssh built-in) | `npm install -g smee-client` |
| URL stability | changes every restart | permanent channel URL |
| Webhook registration | auto (org/repo hook API) | manual (one-time, point to smee URL) |
| Missed events | lost permanently | queued + replayed |
| Dead-tunnel detection | periodic health check (PR #29) | N/A — relay handles reconnect |

**Why localhost.run stays the default now:**
- Zero-install is the core UX promise; requiring `npm install -g smee-client` adds friction on first run.
- Manual webhook registration is a steeper setup step.
- The health-check fix (PR #29) closes the most common failure mode for localhost.run.

**Path to making smee the default:**
1. Ship smee backend (this PR) and gather feedback in production.
2. If missed-event reports drop to zero and install friction proves manageable, flip default in a minor version bump.
3. `crosscheck init` can auto-generate a smee channel (via the smee.io API) and write `tunnel.smee_channel` to config, making setup zero-manual-steps.

**Config contract (shipped):**
```yaml
tunnel:
  backend: smee          # localhost.run | smee
  smee_channel: https://smee.io/your-channel-id
```

**Implementation:**
- `schema.ts`: `TunnelConfigSchema` with `backend` and `smee_channel`; added to `ConfigSchema`
- `watch.ts`: after banner print, branch on `config.tunnel.backend`; smee mode spawns `smee --url <channel> --path <path> --port <port>` and auto-restarts on exit; `currentTunnelProc` shared with cleanup handler
- `init.ts`: checks if `smee` CLI is installed; shows one-line tip if missing
- `crosscheck.config.example.yml`: commented tunnel section with full instructions

---

#### Deployment Mode & Smart Scope Detection

**Problem:** crosscheck has no concept of *why* it's running — is this a developer's laptop monitoring their own work, or a shared server watching an entire team's org? Today:
- Personal users must manually discover that `users:` exists; they can't say "watch everything I own."
- Team operators who run `crosscheck serve` with no author filter inadvertently review every PR in the org from any author.
- There's no auto-detection of org memberships — users copy-paste org names by hand.
- An inaccessible repo in `repos:` silently drops events with no diagnostic.

**Solution:** introduce `deployment: personal | team` as a first-class config concept. `crosscheck watch` and `crosscheck serve` prompt the user to choose a mode on first run (when `deployment` is absent from config), detect scopes from GitHub credentials based on the choice, write everything to config, and proceed — no restart required. `crosscheck init` is unchanged; it remains a pure environment check.

**Scope model:**

| Level | Config key | Coverage | Registration |
|---|---|---|---|
| Repo | `repos:` | Named repos only | One webhook per repo; validated at startup |
| Org | `orgs:` | All repos in org | One webhook per org (GitHub org webhook) |
| User | `users:` | All non-archived personal repos | Enumerated at startup; one webhook per repo |

All three are additive — a config can mix `orgs:` + `users:` + `repos:`.

**Deployment modes:**

| | `personal` | `team` |
|---|---|---|
| Primary use case | Developer laptop running `crosscheck watch` | Shared server running `crosscheck serve` |
| Auto-detected scopes | `users=[self]` + `orgs=[all-memberships]` | `orgs=[all-memberships]` only |
| Default `allowed_authors` | `[self]` — only the owner's PRs | `[]` — all PRs in monitored scope |
| Personal repos monitored | Yes | No |

**First-run prompt (watch and serve):**

Shown before the startup banner when `deployment` key is absent from config. Printed once; after the user answers, the choice is persisted and never asked again.

```
crosscheck watch

How are you using crosscheck?

  [1] personal  — monitor all your repos and orgs; review only PRs you author
  [2] team      — monitor org repos only; review all PRs from any author

Choice [1]:
```

After selecting, crosscheck detects GitHub login + org memberships and writes to config:

Personal (`[1]`):
```yaml
deployment: personal
users:
  - beingzy               # auto-detected from gh auth
orgs:
  - motivation-labs       # auto-detected from org memberships
  - codatta
routing:
  allowed_authors:
    - beingzy
```

Team (`[2]`):
```yaml
deployment: team
orgs:
  - motivation-labs
  - codatta
# users: omitted — personal repos excluded in team mode
# allowed_authors: omitted — all PRs reviewed
```

**Three ways to control the mode:**

| | Prompt shown? | Config written? | Use case |
|---|---|---|---|
| First run (no `deployment` in config) | Yes | Yes | Initial setup |
| `--personal` / `--team` flag | No | **No** | One-time override, CI pipelines |
| `--reconfigure` flag | Yes (shows current mode) | Yes (overwrites) | Switching modes permanently, re-detecting after joining a new org |

```bash
crosscheck watch --personal       # personal mode this session only, config unchanged
crosscheck serve --team           # team mode this session only, config unchanged
crosscheck watch --reconfigure    # re-prompts, saves new choice to config
```

**`--reconfigure` prompt** (shows current saved mode):

```
Reconfiguring deployment mode...

How are you using crosscheck?

  [1] personal  — monitor all your repos and orgs; review only PRs you author
  [2] team      — monitor org repos only; review all PRs from any author

Current: personal
Choice [1]:
```

Re-detecting after the choice always refreshes org memberships and repo lists — useful after joining a new org without switching modes.

**Runtime auto-detection (when explicit scopes are missing):**

If `deployment` is set but `users`, `orgs`, `repos` are all empty (e.g., user manually cleared them), watch/serve auto-detect scopes at startup without prompting:
- `deployment: personal` → detect `users=[self]` + `orgs=[memberships]`
- `deployment: team` → detect `orgs=[memberships]` only

Banner line: `  deployment  personal` or `  deployment  team`.

**Repo accessibility validation:**

At startup, for each entry in `repos:`, call `GET /repos/{owner}/{repo}` in parallel. Any that return 404 or 403 produce:
```
  ✗ repo not accessible: acme/old-repo — skipped (404 Not Found)
```
Remaining accessible repos continue normally. Non-crashing — a stale entry shouldn't halt the whole session.

**New API functions (`src/github/client.ts`):**

```typescript
// Returns org login strings for all active memberships of the authenticated user
listUserOrgs(token: string): Promise<string[]>

// Returns false on 404/403; true on 200; throws on network error
checkRepoAccessible(owner: string, repo: string, token: string): Promise<boolean>
```

**New loader functions (`src/config/loader.ts`):**

```typescript
// Returns scopes to use for auto-detection based on deployment mode
detectScopesForDeployment(
  deployment: 'personal' | 'team',
  token: string
): Promise<{ users: string[]; orgs: string[] }>

// Writes deployment, users, orgs, allowed_authors to config file; no-op if deployment already set
patchScopesAndDeployment(
  configPath: string,
  deployment: 'personal' | 'team',
  login: string,
  orgs: string[]
): boolean
```

**Interaction with existing `patchAllowedAuthors`:**

`patchScopesAndDeployment` supersedes the single-field `patchAllowedAuthors` for new installs. `patchAllowedAuthors` is kept for backward compatibility (existing configs that already have `deployment` omitted but `allowed_authors` empty).

---

#### `crosscheck coverage` — Gap Analysis and Self-Improvement Engine

**Problem:** crosscheck runs silently in the background and users have no way to know what percentage of eligible PRs it actually reviewed. Missed PRs fall into several categories — author filter excluded them, no attribution footer existed, the webhook wasn't registered during that window, or an unknown AI agent wrote the PR. Without a way to enumerate these gaps, users can't tell whether their config is optimal or whether a crosscheck feature is missing. And when a feature *is* missing, there's currently no automated path from "I spotted the gap" to "I filed a proposal" to "I implemented the fix."

**Solution:** `crosscheck coverage` enumerates all PRs in the monitored scope during the crosscheck uptime window, joins that list against review logs, classifies each missed PR by root cause, and routes each class to the right remediation:

- **Config gaps** (author filter, missing `author_routes`, disabled vendor) → suggest and optionally apply config changes; optionally file a best-practice issue to the crosscheck repo
- **Feature gaps** (unrecognized AI agent attribution, unsupported routing pattern) → draft a prd.md feature proposal; optionally clone `motivation-labs/crosscheck`, write the implementation, and open a ready-for-review PR

**Why this is different from `diagnose`:**

`diagnose` reads error events — things that broke during a review that *was attempted*. `coverage` reads the inverse: PRs that were never attempted at all. The two are complementary: `diagnose` finds quality problems in the review pipeline; `coverage` finds scope problems upstream of it.

**Self-improvement loop:**

```
crosscheck running
       ↓
   coverage gap detected
       ↓
   config gap?  ──────────────→  --apply (config write) or --issue (best-practice PR)
       ↓
   feature gap? ──────────────→  --prd (prd.md proposal PR, draft)
                                  --build (implement + ready PR)
```

The `--build` path makes this the first crosscheck command that contributes back to its own development autonomously: it clones the repo, detects exactly which detection pattern or config handling is missing, implements it, adds tests, updates prd.md, and opens a PR. The human reviews and merges.

**Gap classification decision tree:**

```
PR in scope (full analysis period), not in reviewed logs
  └─ PR overlaps any uptime window?
       NO → offline_window          (config_info: crosscheck was offline)
       YES
       └─ PR author in allowed_authors?
            NO → author_filtered    (config_fix: add to allowed_authors)
            YES
            └─ webhook event arrived for this PR?
                 NO → webhook_miss  (config_fix: webhook not registered)
                 YES
                 └─ PR body matches any attribution pattern?
                      YES → reviewer assigned?
                              NO → no_reviewer       (config_fix: enable vendor)
                              YES → flag as anomaly (reviewed but not logged)
                      NO → PR authored by a known-but-unsupported AI agent?
                              YES → unsupported_agent  (feature_request: add detection pattern)
                              NO
                              └─ author in author_routes?
                                   YES → (shouldn't be here — flag as anomaly)
                                   NO  → no_attribution  (config_fix: add author_routes)
```

**Uptime window computation:**

Session boundaries from log entries:
```
session_start @ 09:00 → session_end @ 17:00   window: [09:00, 17:00]
session_start @ 18:00 → (no session_end)       window: [18:00, next-log-ts]
```

Overlapping windows are merged. A PR's uptime membership check: `window.some(w => pr.updated_at >= w.start && pr.created_at <= w.end)`.

**`--issue` payload (config gaps):**

Filed to `motivation-labs/crosscheck`. Body uses only aggregate counts and pattern types — no GitHub usernames, repo names, org names, PR numbers, or branch names. Body structure:
```
## Config best-practice gap: author_filtered

**Condition:** `allowed_authors` is set and PRs from a bot account matching the
pattern `*[bot]` are being skipped.

**Ideal behavior:** `crosscheck init` or `crosscheck watch` startup should warn when
known bot accounts (dependabot, renovate, copilot-workspace) are active in any
monitored repo but absent from `allowed_authors`.

**Suggested detection:** at startup, if `allowed_authors` is non-empty, check whether
recent PR authors in monitored scope include any `*[bot]` logins not in the list.
Warn with: "3 PRs from bot accounts were skipped — add them to allowed_authors or
switch to team mode."

**Supporting data:** N PRs skipped over 14 days across M repos (counts only — no identifiers).
```

Sanitization applied before generating the body: all GitHub logins replaced with their category (e.g., `bot account`, `human author`); repo/org names replaced with counts; PR numbers omitted entirely.

**`--build` agent prompt structure:**

```
You are implementing a feature for crosscheck (an AI code review orchestrator).

Gap type: unsupported_agent
Description: PRs authored by `copilot-swe-agent[bot]` are not being recognized
as AI-authored and therefore not reviewed. crosscheck needs a detection pattern
for this agent's attribution footer.

GitHub Copilot attribution footer: "Co-Authored-By: GitHub Copilot <>"

Task:
1. Add `'Co-Authored-By: GitHub Copilot'` to `claude_reviews_patterns` default in
   `src/config/schema.ts` (GitHub Copilot is reviewed by Claude, as Codex reviews Claude-authored code).
2. Update `crosscheck.config.example.yml` with the new pattern, commented.
3. Update `get-started.md` routing section with a note about GitHub Copilot support.
4. Add a test case to the routing test suite verifying the new pattern matches.

Do not touch any other files. Do not change existing patterns.
```

**Implementation phasing:**

Phase 1 (this feature): Config-gap detection + `--apply` + `--issue`. Delivers immediate value, no cloning required.

Phase 2: `--prd` — generates prd.md proposal, opens draft PR. No code generation.

Phase 3: `--build` — full autonomous contribution. Requires careful scoping of the agent prompt to prevent scope creep.

---

### 🔭 Backlog

- [ ] **smee.io as default tunnel** — once smee proves stable in production, flip `tunnel.backend` default from `localhost.run` to `smee`. Migration: `crosscheck init` auto-generates a smee channel and writes it to config. Old configs keep working (localhost.run continues to work). Track: has `smee-client` install friction reduced? Are missed-event reports gone?

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
