# Crosscheck Scan + Kickass Agent Tickets

## Project Structure

Initiative: PR operator queue for stale crosscheck work

Project: Crosscheck (Motivation Labs Linear workspace)

Milestones:

- M1 Scan foundation and cached reporting
- M2 Kickass selection, preflight, and workflow dispatch
- M3 Merge action hardening and docs

## Dependency Map

- T01 -> blocks T02, T03, T04, T05
- T02 -> blocks T03
- T03 -> blocks T04, T05
- T04 -> parallel with T05 after T03
- T04, T05 -> blocks T06

## Tickets

### T01 [M1] [Foundation] Build open PR status scanner and folding model

Goal and context:

Create the shared scanner that classifies every open PR in configured monitor scope by freshness and workflow state. This is the data foundation for both `crosscheck scan` and `crosscheck kickass`.

Scope:

- Extend `src/lib/backtrace.ts` into a reusable open-PR scanner.
- Add `scanOpenPRStatuses(scopes, config, token, opts)` returning a typed `ScanResult`.
- Add `src/lib/pr-status.ts` for annotation parsing, log folding, stale/fresh computation, progress summaries, token totals, and next-action selection.
- Include states `PR`, `APPROVE`, `NEEDS_WORK`, `BLOCK`, `FIX`, `RECHECK`.
- Compute `last_active` from PR `updated_at`, crosscheck comments, workflow logs, commits, and commit status updates where available.
- Treat crosscheck annotations as source of truth; logs enrich display but must be optional.

Out of scope:

- CLI rendering.
- Multi-select picker.
- Workflow execution or merging.

Acceptance criteria:

- No crosscheck comment for current head SHA folds to `PR` with next action `CR`.
- Latest `APPROVE` folds to `APPROVE` with next action `merge`.
- Latest `NEEDS_WORK` or `BLOCK` folds to next action `fix`.
- Later fix without later recheck folds to `RECHECK` with next action `recheck`.
- Progress summary renders `PR -> CR -> [Fix -> Recheck] * N`, capped at two automated rounds in display.
- Token totals aggregate `review_complete`, `fix_complete`, and `conflict_resolve_complete` logs for the same PR/head SHA.

Engineering quality bar:

- TypeScript strict; no `any`.
- All GitHub API calls go through `src/github/*`.
- Independent repo and PR reads run through `Promise.all`.
- Missing logs or partial per-PR metadata never crash the full scan.

Implementation notes:

- Reuse existing `BacktraceScope`, `buildScopesFromConfig`, and repo expansion patterns.
- Add GitHub client helpers for comments/commits/status metadata instead of raw API calls in command files.
- Keep scanner pure enough to unit-test with fixture GitHub/log inputs.

Files to inspect:

- `src/lib/backtrace.ts`
- `src/github/client.ts`
- `src/github/detector.ts`
- `src/lib/logger.ts`
- `src/lib/event-fields.ts`
- `src/lib/runner.ts`
- `src/lib/verdict.ts`

Dependencies:

- None.

Verification:

- `npm run typecheck`
- `npm run build`
- Unit tests for each state transition, annotation precedence, stale threshold, and token folding.

### T02 [M1] [Vertical slice] Add `crosscheck scan` CLI with cache and tidy/json output

Goal and context:

Expose the scanner as a user-facing command that summarizes open PR status across configured monitor repos.

Scope:

- Add `src/commands/scan.ts`.
- Wire `crosscheck scan [--tidy] [--force] [--stale-after <duration>] [--json]` in `src/cli.ts`.
- Add `src/lib/scan-cache.ts` for `~/.crosscheck/cache/scan.json` with 60-second TTL.
- Add `src/lib/durations.ts` for parsing `30m`, `2h`, `1d` and formatting elapsed times.
- Render terminal output grouped by freshness first, then state.
- `--tidy` prints only stale actionable rows.
- `--json` emits the full scan result with raw timestamps and token splits.

Out of scope:

- Picker or execution.
- Merge preflight.

Acceptance criteria:

- Default output shows `STALE` and `NOT STALE` groups when both exist.
- Rows include PR key, title, author, branch, head SHA short, latest verdict, progress summary, elapsed since created, elapsed since last active, tokens, next action, and URL.
- Cache key includes config path, monitor scope hash, GitHub login, `stale_after`, and package version.
- `--force` bypasses cache and rewrites it after a successful scan.
- Partial GitHub failures are reported and do not overwrite the last successful cache.

Engineering quality bar:

- `cli.ts` remains command wiring only.
- Exit code `1` for user errors like invalid duration; exit code `2` for unexpected errors.
- JSON output is stable and test-covered.

Implementation notes:

- Use `getGithubToken()` and `loadConfig()` patterns from existing commands.
- Cache directory should be created lazily.
- Keep terminal table compact; avoid wrapping long titles by truncating with ellipsis.

Files to inspect:

- `src/cli.ts`
- `src/commands/diagnose.ts`
- `src/commands/impact.ts`
- `src/config/loader.ts`
- `package.json`

Dependencies:

- T01.

Verification:

- `npm run typecheck`
- `npm run build`
- Tests for duration parsing, cache hit/miss/force behavior, tidy filtering, and JSON shape.

### T03 [M2] [Foundation] Add kickass picker and preflight planner

Goal and context:

Let operators select stale actionable PRs and see exactly what crosscheck will do before any mutation.

Scope:

- Add `src/commands/kickass.ts` command skeleton.
- Add `src/lib/pr-picker.ts` multi-select picker for stale actionable PRs.
- Build a preflight planner that groups selections by transition: `PR -> CR`, `NEEDS_WORK -> Fix`, `BLOCK -> Fix`, `FIX -> Recheck`, `RECHECK -> Recheck`, `APPROVE -> Merge`.
- Stable PR signature format: `<owner>/<repo>#<number>@<headSha7> [<state> -> <action>]`.
- Support `crosscheck kickass [--force] [--stale-after <duration>] [--dry-run]`.

Out of scope:

- Running review/fix/recheck.
- Performing merges.

Acceptance criteria:

- `kickass` always runs scan first and uses the 1-minute cache unless `--force` is passed.
- Picker groups rows by next action and shows stale PRs only.
- Preflight prints selected PRs grouped by transition with reviewer/fixer/merge method when known.
- Operator confirmation is required before mutation.
- `--dry-run` exits 0 after preflight and does not call any mutators.

Engineering quality bar:

- Picker works in non-TTY fallback by printing a clear error and exit code `1`.
- Preflight revalidates head SHA before presenting planned actions.
- No mutation happens before explicit confirmation.

Implementation notes:

- Reuse rendering patterns from `src/lib/repo-picker.ts`.
- Preflight should downgrade `NEEDS_WORK/BLOCK -> Fix` to `PR -> CR` when no fresh review comment exists for the current head SHA.
- Keep execution sequential in later tickets; do not add concurrency now.

Files to inspect:

- `src/lib/repo-picker.ts`
- `src/commands/onboard.ts`
- `src/commands/run.ts`
- `src/github/detector.ts`

Dependencies:

- T01
- T02

Verification:

- `npm run typecheck`
- `npm run build`
- Tests for picker filtering, preflight grouping, dry-run behavior, and stale-signature detection.

### T04 [M2] [Vertical slice] Execute kickass review, fix, and recheck actions

Goal and context:

Make selected stale PRs advance through existing crosscheck workflow actions without duplicating business logic.

Scope:

- Implement `PR -> CR` by dispatching the same path as `crosscheck run <pr-url> --steps review`.
- Implement `NEEDS_WORK -> Fix` and `BLOCK -> Fix` by dispatching `--steps fix` with the latest fresh review comment.
- Implement `FIX -> Recheck` and `RECHECK -> Recheck` by dispatching `--steps recheck` and linking to the latest fresh review comment.
- Preserve origin detection, reviewer assignment, local lock, remote lock, comments, and structured logs.
- Skip if head SHA changed since scan signature.

Out of scope:

- Merge action.
- Parallel execution.

Acceptance criteria:

- Each selected non-merge PR runs sequentially.
- Head SHA mismatch skips with reason `stale_signature`.
- Fix action downgrades to review when no usable current-head review comment exists.
- Existing lock behavior prevents duplicate concurrent workflow execution.
- Results summary reports succeeded, skipped, and failed PRs.

Engineering quality bar:

- Avoid shelling out to the CLI from inside the command; call shared command/workflow functions directly.
- No duplicate implementation of reviewer assignment or workflow step execution.
- Unexpected errors on one PR do not stop remaining selected PRs unless the operator aborts.

Implementation notes:

- Extract reusable internals from `src/commands/run.ts` if needed rather than adding a second runner.
- Keep mutation order deterministic: sorted by picker order.
- Reuse `loadWorkflow()` and step filtering.

Files to inspect:

- `src/commands/run.ts`
- `src/lib/runner.ts`
- `src/github/review-status.ts`
- `src/lib/pr-lock.ts`
- `src/github/client.ts`

Dependencies:

- T03.

Verification:

- `npm run typecheck`
- `npm run build`
- Tests for action dispatch, stale-signature skip, fix downgrade, per-PR error isolation, and dry-run no-op.

### T05 [M3] [Integration] Add kickass merge preflight and approved-PR merge action

Goal and context:

Allow `crosscheck kickass` to safely merge stale approved PRs when all merge preconditions still hold.

Scope:

- Add `src/github/merge.ts` for merge preflight and merge execution via Octokit.
- For `APPROVE -> Merge`, require matching head SHA, mergeable PR, green required checks, and branch protection acceptance.
- Default method is `squash`; if squash is unavailable, use first allowed method in `squash`, `merge`, `rebase` order.
- Skip with `merge_preflight_failed` when any precondition fails.
- Include merge result in final kickass summary.

Out of scope:

- Custom merge method config.
- Auto-delete branch.
- Bypassing branch protection.

Acceptance criteria:

- Approved stale PRs are merged only when all preflight checks pass.
- PR with changed head SHA skips with `stale_signature`.
- PR with failing/pending required checks skips.
- PR with `mergeable: false` or still-null after retry skips.
- Branch protection/API rejection is reported without crashing other selected PRs.

Engineering quality bar:

- GitHub API calls stay under `src/github/*`.
- No raw `fetch` in command files.
- Merge mutation is covered by tests with mocked Octokit responses.

Implementation notes:

- GitHub `mergeable` can be `null` while computing; retry briefly before skipping.
- Use commit/check status APIs already available in Octokit.
- Log merge attempts and outcomes to structured logs without secrets.

Files to inspect:

- `src/github/client.ts`
- `src/commands/kickass.ts`
- `src/lib/logger.ts`

Dependencies:

- T03.

Verification:

- `npm run typecheck`
- `npm run build`
- Tests for merge method selection, green/failing checks, null mergeable retry, branch protection rejection, and successful merge.

### T06 [M3] [Quality] Document scan/kickass and add end-to-end command coverage

Goal and context:

Make the new operator commands discoverable and protect the public CLI contract with focused tests.

Scope:

- Update `get-started.md` with a section for `crosscheck scan` and `crosscheck kickass`.
- Update `README.md` command list if present.
- Add examples for default scan, tidy scan, forced refresh, kickass dry-run, and kickass execution.
- Add command-level tests or smoke tests for CLI wiring and exit codes.
- Confirm no config schema changes are needed for v1.

Out of scope:

- Full docs rewrite.
- New config defaults.

Acceptance criteria:

- Docs explain stale vs not-stale and states `PR`, `APPROVE`, `NEEDS_WORK`, `BLOCK`, `FIX`, `RECHECK`.
- Docs explain the 1-minute local cache and `--force`.
- Docs explain that `kickass` requires confirmation and runs sequentially.
- CLI help includes all new flags.
- `npm run typecheck` and `npm run build` pass.

Engineering quality bar:

- Keep public CLI changes explicit because command names and flags are part of the public API contract.
- Avoid documenting future flags like concurrency as available.
- Ensure docs match `prd.md`.

Implementation notes:

- If a config field is added later, update `schema.ts`, `crosscheck.config.example.yml`, and `get-started.md` together.
- Mention that `kickass --dry-run` is the safe preflight path.

Files to inspect:

- `README.md`
- `get-started.md`
- `src/cli.ts`
- `package.json`

Dependencies:

- T04
- T05

Verification:

- `npm run typecheck`
- `npm run build`
- CLI help smoke test for `scan` and `kickass`.

## Coding-Agent Handoff

### Packet A: Scanner And Scan CLI

Owns:

- T01
- T02

Primary files to inspect:

- `src/lib/backtrace.ts`
- `src/github/client.ts`
- `src/commands/scan.ts`
- `src/lib/scan-cache.ts`
- `src/lib/pr-status.ts`

Constraints:

- Reuse monitor scope expansion.
- Annotation truth beats local logs.
- Cache must not update on partial scan failure.

Verification:

- `npm run typecheck`
- `npm run build`
- Scanner/cache/status folding unit tests.

### Packet B: Kickass Workflow Actions

Owns:

- T03
- T04

Primary files to inspect:

- `src/commands/kickass.ts`
- `src/commands/run.ts`
- `src/lib/runner.ts`
- `src/lib/pr-lock.ts`
- `src/github/review-status.ts`

Constraints:

- No mutation before confirmation.
- Reuse existing workflow execution logic.
- Sequential execution only.

Verification:

- `npm run typecheck`
- `npm run build`
- Dry-run, preflight, dispatch, and stale-signature tests.

### Packet C: Merge And Documentation

Owns:

- T05
- T06

Primary files to inspect:

- `src/github/merge.ts`
- `src/commands/kickass.ts`
- `README.md`
- `get-started.md`
- `src/cli.ts`

Constraints:

- Never bypass branch protection.
- Merge only matching scanned head SHA.
- Document only implemented flags.

Verification:

- `npm run typecheck`
- `npm run build`
- Merge preflight tests and CLI help smoke tests.

## Open Questions

- Should `APPROVE -> Merge` be enabled in the first implementation or hidden behind a later explicit flag if teams are nervous about automated merges?
- Should default `--stale-after` remain hardcoded at `24h`, or should a future config field be added after usage patterns are clearer?
- Should `FIX` and `RECHECK` remain separate user-visible states, or collapse into one `RECHECK` state in terminal output after user testing?
