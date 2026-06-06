# ISSUE.md — crosscheck issue analysis harness

You are analyzing `~/.crosscheck/logs/*.ndjson` to find bugs and improvement opportunities
in the crosscheck project and draft GitHub issues for `humanbased-ai/crosscheck`.

Your job is to surface patterns that a simple error-count approach would miss: session
instability, tunnel failure modes, process crash loops, and reliability regressions.

---

## Log schema

Each line in a `.ndjson` file is one JSON event with at minimum:

```
{ "ts": "<ISO-8601 UTC>", "level": "info|warn|error", "event": "<name>", ...fields }
```

### Events that matter most

| Event | Key fields | Meaning |
|---|---|---|
| `session_start` | `command` | A new watch/serve process started |
| `session_end` | — | Process exited cleanly (graceful shutdown) |
| `tunnel_opened` | `url` | Tunnel is live; url is `lhr.life` or `smee.io` |
| `tunnel_closed` | `reconnecting: bool` | Tunnel dropped; reconnecting if true |
| `tunnel_error` | `message` | SSH failure; message contains "did not start within" (timeout) or "exit (code 255)" (hard exit) |
| `webhook_registered` | `repo` | Webhook confirmed active |
| `webhook_register_retry` | — | Webhook registration retrying |
| `webhook_error` | `message` | Webhook registration failed |
| `pr_received` | `repo`, `pr` | Incoming PR event |
| `review_started` | `reviewer`, `pr` | Review agent invoked |
| `review_complete` | `verdict`, `duration_ms` | Review finished |
| `verdict_parse_failed` | — | Agent output did not contain a parseable VERDICT line |
| `error` | `message` | Any runtime error |

---

## How to compute sessions

Split all log entries on `session_start` events. Each session is the slice of events
from one `session_start` up to (but not including) the next `session_start`.

For each session compute:

| Field | How |
|---|---|
| `duration_min` | `(last_event.ts - session_start.ts)` in minutes |
| `clean_exit` | Session contains a `session_end` event |
| `tunnel_opened` | Any `tunnel_opened` event present |
| `tunnel_type` | `"lhr.life"` / `"smee.io"` / `"none"` from tunnel url |
| `tunnel_error_count` | Count of `tunnel_error` events |
| `ssh_timeout_count` | `tunnel_error` where message contains `"did not start within"` |
| `ssh_255_count` | `tunnel_error` where message contains `"255"` |
| `reconnect_count` | `tunnel_closed` events where `reconnecting: true` |
| `webhook_registered` | Any `webhook_registered` event present |
| `pr_received` | Any `pr_received` event present |
| `review_completed` | Any `review_complete` event present |
| `error_count` | Events where `level == "error"` |

---

## Analysis 1 — Session stability

Compute per-session stats and then aggregate.

**Aggregate metrics to report:**
- Total sessions, total days covered
- Average / median session lifespan (minutes)
- % sessions with clean exit (`session_end` present)
- % sessions where tunnel never opened
- % sessions where webhook was never registered
- Longest and shortest session

**Thresholds that indicate a reportable problem:**

| Condition | Severity | Report type |
|---|---|---|
| avg session lifespan < 15 min across any single day | high | bug |
| > 40% of sessions never reach `tunnel_opened` | high | bug |
| > 50% of sessions have no `session_end` (abrupt death) | medium | improvement |
| ≥ 5 sessions in any 90-minute window all under 5 min | high | bug — rapid restart loop |
| > 30% of sessions have no `webhook_registered` | medium | improvement |

---

## Analysis 2 — Tunnel reliability

**Aggregate metrics:**
- Count of `tunnel_opened`, `tunnel_closed`, `tunnel_error` across all sessions
- SSH timeout count vs SSH code-255 count (from `tunnel_error` messages)
- Reconnect rate: `reconnect_count / tunnel_closed_count`
- Terminal close rate: `tunnel_closed` where `reconnecting: false`
- % of sessions that never reached `tunnel_opened`

**Key insight to encode:** Sessions that accumulate many tunnel errors and reconnects
can still survive long — the reconnect logic is working. The real kill signal is
`tunnel_opened == false`, not high `tunnel_error_count`.

**Thresholds:**

| Condition | Severity | Report type |
|---|---|---|
| SSH timeout rate > 60% of tunnel errors | high | bug — connectivity or lhr.life instability |
| SSH code-255 rate > 20% of tunnel errors | high | bug — SSH process crash |
| Terminal close rate > 30% of tunnel closes | high | bug — tunnel not recovering |
| > 40% sessions never open a tunnel | high | bug |

---

## Analysis 3 — Process health (crash loops)

This is distinct from tunnel failure. A process crash loop has these signatures:
- Rapid session restarts (≥ 5 sessions in 90 minutes)
- Sessions dying before `tunnel_opened` with **zero** tunnel errors
- `error` events containing `gh repo clone`, `Command failed`, or `ENOENT`
- Sessions with normal `tunnel_error_count` but very short lifespan

**What to look for:**
- Cluster rapid-restart windows: sessions where `duration_min < 5` AND `tunnel_opened == false`
  AND `tunnel_error_count == 0`. These are process crashes, not connectivity failures.
- Extract the `error` event messages from those sessions to identify the root cause.
- Check if `verdict_parse_failed` or `webhook_error` events appear in the final 60 seconds
  of abrupt-death sessions — these indicate the review or webhook path is triggering exits.

**Thresholds:**

| Condition | Severity | Report type |
|---|---|---|
| ≥ 5 sessions: duration < 5 min AND tunnel_opened=false AND tunnel_errors=0 | critical | bug — startup crash loop |
| `gh repo clone` in any error message | high | bug — clone failure |
| `verdict_parse_failed` in final 60s of > 20% abrupt-death sessions | medium | improvement — VERDICT format reliability |

---

## The two failure modes (always distinguish these in your report)

**Mode A — Tunnel failure:** Sessions die because SSH connectivity fails and the tunnel
never comes up. Signals: `ssh_timeout_count > 0` OR `ssh_255_count > 0` in failed sessions.
Root cause: network, lhr.life instability, or SSH configuration.

**Mode B — Process crash:** Sessions die fast with zero tunnel errors. The process exits
before even attempting a tunnel. Signals: `duration_min < 3`, `tunnel_opened = false`,
`tunnel_error_count = 0`, error messages about `gh`, `clone`, `ENOENT`, or similar.
Root cause: code bug, missing dependency, bad config, or file system issue.

Never combine these two modes in a single issue. They have different root causes and
different fixes.

---

## Improvement opportunities (not bugs)

File an improvement issue when the system is working but data shows a reliability gap:

| Pattern | Issue title pattern | Label |
|---|---|---|
| avg session lifespan 15–30 min (should be hours) | `watch: improve session longevity — avg Xmin` | `improvement` |
| smee.io has 0 tunnel errors but lhr.life does not | `watch: add smee.io as automatic tunnel fallback` | `improvement` |
| Reconnect works but adds latency | `tunnel: reduce reconnect gap when lhr.life drops` | `improvement` |
| `webhook_registered` strongly predicts session survival | `watch: surface webhook status earlier in startup sequence` | `improvement` |
| `verdict_parse_failed` events in logs | `review: harden VERDICT line parsing — N parse failures found` | `improvement` |

---

## Output format

For each issue you file, output exactly:

```
TITLE: <concise title under 80 characters>
LABELS: <comma-separated: bug, improvement, priority:high, priority:low>
---
<GitHub-flavored markdown body>
```

### Required body sections

**For bugs:**
```markdown
## Summary
One paragraph describing the failure pattern and impact on the user.

## Evidence from logs
Exact metrics from your analysis (counts, percentages, session table if relevant).
Use a code block for representative raw log entries — sanitize any PII or tokens.

## Failure mode
State clearly: Mode A (tunnel failure) or Mode B (process crash), and why.

## Reproduction signals
What log patterns indicate this bug is active. How to check if it's happening.

## Suggested fix direction
One sentence on where in the codebase to look. Do not prescribe the implementation.

## Environment
crosscheck version (from log entries if present), platform, date range analyzed.
```

**For improvements:**
```markdown
## Summary
One paragraph describing the opportunity and expected benefit.

## Evidence from logs
The metrics that surfaced this opportunity.

## Current behavior vs desired behavior
Two-line contrast: what happens now, what should happen instead.

## Suggested approach
One paragraph, high level. Do not write code.
```

---

## What NOT to report

- Single-occurrence errors with no clear pattern
- Events that are expected (e.g., one `tunnel_closed` followed immediately by `tunnel_opened`)
- Issues already covered by an existing `crosscheck diagnose` error pattern
  (`command_not_found`, `base_branch_missing`, `timeout`, `auth_failure`)
- Anything requiring access to source code you were not given — stay in the log data

---

## Prioritization

If you find multiple issues, report them in this order:
1. Startup crash loops (Mode B, critical) — they prevent any work from happening
2. Tunnel-never-opens rate > 40% (Mode A, high) — degrades session reliability
3. Short average session lifespan (< 15 min/day) — signals chronic instability
4. Improvement opportunities — after bugs are covered
