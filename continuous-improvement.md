# Continuous Improvement Log

Records observed failures, root causes, and suggested actions surfaced during `ck optimize` runs and manual analysis. Use this to track signal that doesn't belong in prd.md (bugs, regressions, CLI drift) and to close the loop after fixes land.

---

## 2026-05-10 — `ck optimize` fails when codex is selected as agent

### Observed

```
✗ codex failed: Command failed with exit code 2: codex -q 'Read OPTIMIZE_PROMPT.md ...'
error: unexpected argument '-q' found
  tip: to pass '-q' as a value, use '-- -q'
```

### Root Cause

`src/commands/optimize.ts:112` invokes `codex -q '...'`. The `-q` flag does not exist in the current codex CLI. The correct non-interactive invocation is `codex exec '...'`.

This is a divergence from `src/commands/issue.ts:146`, which already uses `codex exec --skip-git-repo-check '...'` correctly. `optimize.ts` was not updated when the codex CLI changed.

### Suggested Fix

In `runWithCodex` inside `optimize.ts`, replace:

```typescript
execa('codex', ['-q', 'Read OPTIMIZE_PROMPT.md ...'], { cwd: tmpDir, ... })
```

with:

```typescript
execa('codex', ['exec', '--skip-git-repo-check', 'Read OPTIMIZE_PROMPT.md ...'], { cwd: tmpDir, ... })
```

`--skip-git-repo-check` is required because the working directory is a throwaway tmp dir with no git repo — same reason `issue.ts` includes it.

### Secondary Finding — Weak Error Handling

The `runWithCodex` error handler in `optimize.ts` only catches auth errors (`/not logged in/`). A flag-parse failure (exit code 2, "unexpected argument" in stderr) falls through as a raw process error, giving users no actionable guidance.

**Suggested addition:** detect exit code 2 + "unexpected argument" in stderr and surface:

```
codex invocation error — crosscheck may be using an outdated codex flag. Run: codex --help
```

### Status

- [ ] Fix `-q` → `codex exec --skip-git-repo-check` in `optimize.ts`
- [ ] Add exit-code-2 / unexpected-argument error check in `runWithCodex` (`optimize.ts`)
- [ ] Audit other commands for similar codex CLI flag drift (`status.ts`, `init.ts`, `onboard.ts`)

---

## 2026-05-10 — UTC date bug in log file naming

### Observed

`ck status` displayed `today  1411.8 KB — /Users/beingzy/.crosscheck/logs/2026-05-09.ndjson` while local date was `2026-05-10`.

### Root Cause

`getTodayLogPath()` in `src/lib/logger.ts:95` uses `new Date().toISOString().slice(0, 10)`, which produces a UTC date. For users in UTC+ timezones, this names log files with the previous calendar day during early morning hours. `status.ts:62-65` then labels the result "today", which is wrong.

Secondary impact: reviews run between UTC midnight and local midnight are bucketed into the wrong date file, making retention and impact reports slightly inaccurate for UTC+ users.

### Suggested Fix

Replace UTC-based date derivation with local date:

```typescript
// Before
const today = new Date().toISOString().slice(0, 10)

// After
const today = new Date().toLocaleDateString('en-CA')  // yields YYYY-MM-DD in local time
```

Apply in both `logger.ts:43` (log file creation) and `logger.ts:95` (`getTodayLogPath`).

### Status

- [ ] Fix UTC date → local date in `logger.ts` (lines 43 and 95)

---

## 2026-05-10 — "0 issues caught" is a silent failure signal in `ck status`

### Observed

`ck status` showed `50 reviews · ~48h saved · 0 issues caught` with no further detail.

### Root Cause

`issues_caught` in `impact.ts:116` only increments for `NEEDS_WORK` or `BLOCK` verdicts. Reviews where `parseVerdict` returns `null` (verdict parse failed) are counted in `reviews_without_verdict` and silently excluded from the metric. The status summary line never surfaces `reviews_without_verdict`, so two very different situations look identical:

- **Scenario A:** All 50 reviews returned `APPROVE` — system is working, code is clean.
- **Scenario B:** All 50 reviews have `verdict: null` — verdict parsing is silently failing for every review.

The `reviews_without_verdict` count is only visible when running `ck impact` in full.

### Suggested Fix

Append a warning to the status summary line when `reviews_without_verdict > 0`:

```
50 reviews · ~48h saved · 0 issues caught · 12 missing verdicts ⚠
```

This makes a verdict-parsing regression immediately visible in `ck status` without requiring a separate `ck impact` run.

### Status

- [ ] Surface `reviews_without_verdict` count in the `ck status` impact summary line when nonzero

---

## 2026-05-10 — `ck status` omits two operationally significant config fields

### Observed

`ck status` Config block shows mode, quality tier, models, and budget — but is silent on:
1. Whether the `post_review.auto_fix` (cr → fix) workflow is enabled and how it delivers fixes
2. Which tunnel backend is active (`localhost.run` vs `smee`)

Current live values in `crosscheck.config.yml` that are invisible in status:
```yaml
post_review:
  auto_fix:
    enabled: true
    trigger: on_issues
    delivery:
      mode: pull_request   # creates a fix PR for every NEEDS_WORK/BLOCK review

tunnel:
  backend: localhost.run
```

### Why It Matters

**auto_fix:** A user who forgets `auto_fix.enabled: true` will be surprised to see fix PRs automatically opened. There is no way to verify this is on without opening the config file.

**tunnel:** When `ck watch` or `ck serve` is running, the tunnel backend determines the public webhook URL. `localhost.run` requires an active SSH connection; `smee` queues events while offline. Neither variant nor status (connected / not) is surfaced in `ck status`.

### Suggested Fix

Add to the Config section in `status.ts`:

```typescript
row('auto-fix', config.post_review.auto_fix.enabled
  ? `enabled — ${config.post_review.auto_fix.delivery.mode} on ${config.post_review.auto_fix.trigger}`
  : 'disabled')
row('tunnel', config.tunnel.backend)
```

Example output:
```
  auto-fix               enabled — pull_request on on_issues
  tunnel                 localhost.run
```

### Status

- [ ] Add `auto-fix` row to Config section in `status.ts`
- [ ] Add `tunnel` row to Config section in `status.ts`

---

## 2026-05-10 — Three structural gaps in the `~/.crosscheck/` config mechanism

### Observed

`~/.crosscheck/` currently contains only:
```
instructions.md     # reviewer constraints + verdict format
workflow.yml        # step definitions (review → fix → recheck)
webhook-secret      # raw secret file
logs/               # NDJSON review logs
```

### Gap 1 — No file records setup choices

`ck onboard` makes consequential decisions (tunnel backend, cross-vendor vs single-vendor, vendor models) but writes none of them to `~/.crosscheck/`. Those choices live only in the project-level `crosscheck.config.yml`. There is no global config file capturing the user's environment-level setup, so:
- Running `ck onboard` again overwrites choices silently
- `ck status` has to re-derive settings from the project file rather than a stable home-dir source of truth
- There is no portable record of how the user's machine is configured

**Suggested fix:** `ck onboard` should write a `~/.crosscheck/config.yml` capturing global defaults (tunnel, auth method, preferred models). Project-level `crosscheck.config.yml` overrides it; home-dir file is the fallback.

### Gap 2 — `instructions.md` should be sunset into `workflow.yml`

`instructions.md` is a freestanding file of reviewer constraints and the required verdict format. `workflow.yml` defines steps but each step has no `instructions:` field — so the harness is split across two files with no structural link between them. This means:
- Different steps cannot have different instructions (review vs recheck should emphasize different things)
- `instructions.md` has no schema, no versioning, and is easy to corrupt manually
- The split makes `workflow.yml` incomplete as a self-describing workflow definition

**Suggested fix:** Add an optional `instructions:` field to each step in `workflow.yml`. Migrate `instructions.md` content into the `review` step. Deprecate and eventually remove `instructions.md`.

```yaml
steps:
  - name: review
    type: review
    reviewer: auto
    instructions: |
      Do not run tsc, npm, or test runners.
      Base review solely on reading source files and the diff.
      ...
      VERDICT: APPROVE / NEEDS WORK / BLOCK
```

### Gap 3 — Branding marks have no collection, storage, or materialization path

Crosscheck posts PR comments with hard-coded badges (`✅ **APPROVE**`, `⚠️ **NEEDS WORK**`, `🚫 **BLOCK**`) and fixed annotation tag format. Nothing in `ck onboard` asks about branding, nothing in the config stores it, and `workflow.yml` has no mechanism to inject it into the agent harness.

The correct three-stage flow is missing end to end:

1. **Collect** — `ck onboard` prompts for branding preferences (tool name, comment style, tone, annotation format)
2. **Record** — answers written to `~/.crosscheck/config.yml` as a `branding:` block
3. **Materialize** — `workflow.yml` per-step `instructions:` field embeds the branding choices as agent harness directives, shaping how the agent writes review comments, formats verdicts, and annotates PRs

Without this pipeline, branding is a code constant in `verdict.ts`, not a user configuration. Teams cannot adopt crosscheck under a different internal name, adjust comment tone for their culture, or control the annotation style that downstream tooling reads.

**Suggested design:**

```yaml
# ~/.crosscheck/config.yml (written by ck onboard)
branding:
  name: crosscheck
  tone: direct            # direct | collaborative | formal
  approve_badge: "✅ APPROVE"
  needs_work_badge: "⚠️ NEEDS WORK"
  block_badge: "🚫 BLOCK"
  annotation_prefix: crosscheck   # used in <!-- crosscheck: ... --> tags
```

```yaml
# ~/.crosscheck/workflow.yml (materialized from config by ck onboard or ck init)
steps:
  - name: review
    type: review
    instructions: |
      You are crosscheck, an automated code reviewer.
      Write comments in a direct tone.
      End every comment with one of:
        ✅ APPROVE / ⚠️ NEEDS WORK / 🚫 BLOCK
      Annotate your comment with: <!-- crosscheck: origin=... verdict=... -->
```

This makes `workflow.yml` the single artifact that fully describes agent behavior — branding included — without requiring agents to read a separate config file.

### Status

- [ ] Design and implement `~/.crosscheck/config.yml` written by `ck onboard`
- [ ] Add `instructions:` field to workflow step schema; migrate `instructions.md`; deprecate the standalone file
- [ ] Add branding collection to `ck onboard` prompt sequence
- [ ] Write collected branding to `~/.crosscheck/config.yml` as `branding:` block
- [ ] Materialize branding into per-step `instructions:` in `workflow.yml` during onboard/init
