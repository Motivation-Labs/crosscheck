export interface Tip {
  text: string
  badge?: 'new'
}

export const TIP_INTERVAL_MS = 45_000

export const TIPS: Tip[] = [
  { text: '`ck diagnose` — spot error patterns and per-vendor success rates across all log files' },
  { text: '`ck optimize` — AI-tunes review instructions from log history; use `--apply` to auto-accept' },
  { text: '`ck optimize --dry-run` — preview suggested changes without writing anything' },
  { text: '`ck diagnose --since YYYY-MM-DD` — narrow analysis to a recent time window' },
  { text: '`ck impact` — estimate review time saved and cost avoided by crosscheck reviews' },
  { text: '`ck scan` — list open PRs across monitored repos that have no crosscheck review yet' },
  { text: '`quality.tier: thorough` in config — deeper review; use `balanced` for faster turnaround' },
  { text: '`routing.allowed_authors` — restrict reviews to specific GitHub logins only' },
  { text: '`budget.per_review_usd` — cap per-review spend; `ck optimize` can raise it from log evidence' },
  { text: '`vendors.claude.timeout_sec` — raise this if claude cuts out on large diffs' },
  { text: '`crosscheck watch --backtrace` — catch up on PRs that were opened before watch started' },
  { text: '`crosscheck watch --reconfigure` — change deployment mode and re-detect scopes' },
  { text: '`workflow.yml` — add fix, recheck, or conflict-resolve steps to customise the pipeline' },
  { text: 'step `when: verdict == BLOCK` — run fix steps only on blocked PRs, skip if approved' },
  { text: '`ck optimize` now edits crosscheck.config.yml — fixes `quality.tier` and budget from log evidence', badge: 'new' },
  { text: '`ck diagnose` now shows per-step-type success rates — compare review vs recheck performance', badge: 'new' },
  { text: '`ck optimize` uses agent fallback — if codex fails the step, it retries with claude automatically', badge: 'new' },
  { text: 'smart-switch: crosscheck degrades gracefully to the healthy vendor on persistent API errors' },
  { text: 'diff-hash dedup: force-pushes with the same effective diff are skipped, not re-reviewed' },
]

/**
 * Returns the tip to display at the given wall-clock time.
 * nowMs defaults to Date.now(); pass an explicit value in tests for determinism.
 */
export function selectTip(sessionStartMs: number, nowMs = Date.now()): Tip {
  const idx = Math.floor((nowMs - sessionStartMs) / TIP_INTERVAL_MS)
  return TIPS[((idx % TIPS.length) + TIPS.length) % TIPS.length]
}
