# Configuration

crosscheck looks for a config file in these locations (first found wins):

1. `./crosscheck.config.yml` — current working directory
2. `./.crosscheck.yml` — current working directory
3. `~/.crosscheck/config.yml` — home directory (shared across projects)

Run `crosscheck init` to generate a starter file with all options commented.

---

## Full reference

```yaml
# ── Mode ──────────────────────────────────────────────────────────────────────
mode: cross-vendor
```

| Value | Behaviour |
|---|---|
| `cross-vendor` | Claude Code PRs get reviewed by Codex. Codex PRs get reviewed by Claude. Human PRs are skipped unless routing is customized. |
| `single-vendor` | Every PR gets reviewed by whichever vendor is enabled. |

---

```yaml
# ── Vendors ───────────────────────────────────────────────────────────────────
vendors:
  codex:
    enabled: true
    model: o4-mini
    auth: subscription

  claude:
    enabled: true
    model: sonnet
    effort: medium
```

### `vendors.codex`

| Field | Values | Default | Notes |
|---|---|---|---|
| `enabled` | `true` / `false` | `true` | Set to `false` to disable Codex entirely |
| `auth` | `subscription` / `api-key` | `subscription` | `subscription` uses your ChatGPT Plus/Pro account (device-auth OAuth). `api-key` uses `OPENAI_API_KEY` and enables model selection. |
| `model` | `gpt-4o-mini`, `o4-mini`, `o3` | _(not set)_ | Only applied when `auth: api-key`. Ignored for subscription auth — the ChatGPT plan determines the model. |

### `vendors.claude`

| Field | Values | Default | Notes |
|---|---|---|---|
| `enabled` | `true` / `false` | `true` | |
| `model` | `haiku` / `sonnet` / `opus` | `sonnet` | Maps to the latest version of each tier |
| `effort` | `low` / `medium` / `high` / `max` | `medium` | Controls reasoning depth. Higher effort = slower + costs more subscription quota. |

---

```yaml
# ── Quality ───────────────────────────────────────────────────────────────────
quality:
  tier: balanced
  focus:
    - security
    - types
  custom_prompt: |
    Be concise. Flag only issues that would block a merge.
```

### `quality.tier`

| Tier | Speed | Depth | Best for |
|---|---|---|---|
| `fast` | ~10s | Top issues only, brief comments | High-volume repos, draft PRs |
| `balanced` | ~30s | Full review, all issues explained | Default for most teams |
| `thorough` | ~60–90s | Deep multi-pass, architecture + security | Before merging to main, large PRs |

### `quality.focus`

Optional list of areas to narrow the review. When set, the reviewer prioritises these over general feedback.

Available values: `security`, `types`, `performance`, `naming`, `test-coverage`, `documentation`, `accessibility`

### `quality.custom_prompt`

Free-form text appended to every review prompt. Use this to encode team standards:

```yaml
custom_prompt: |
  Our stack: Next.js App Router, TypeScript strict, Supabase.
  Flag: missing error boundaries, untyped event handlers, direct DB calls outside /lib.
  Skip: style comments, minor naming.
```

---

```yaml
# ── Budget ────────────────────────────────────────────────────────────────────
budget:
  codex_monthly_usd: 20
  per_review_usd: 2.00
```

| Field | Notes |
|---|---|
| `codex_monthly_usd` | Maximum Codex API spend per calendar month. Set to `null` for no cap. Only relevant when `vendors.codex.auth: api-key`. |
| `per_review_usd` | Hard stop per individual Claude review. Passed to `claude --max-budget-usd`. Has no effect on Codex. |

---

```yaml
# ── Repos ─────────────────────────────────────────────────────────────────────
repos:
  - owner: acme
    name: backend
  - owner: acme
    name: frontend
```

The `repos` list is used in `serve` mode to know which repos to expect events from. In `watch` mode the repo is auto-detected from `git remote origin`, so you can leave this empty.

---

```yaml
# ── Routing ───────────────────────────────────────────────────────────────────
routing:
  codex_reviews_patterns:
    - "Generated with \\[Claude Code\\]"
  claude_reviews_patterns:
    - "Generated with \\[OpenAI Codex\\]"
    - "Co-Authored-By: codex"
```

Patterns are matched against the PR body as case-insensitive regular expressions. A PR matches the first pattern list it satisfies.

- `codex_reviews_patterns` — PRs matching these are assigned to Codex for review
- `claude_reviews_patterns` — PRs matching these are assigned to Claude for review

**To also review human PRs**, add a catch-all to one of the lists:

```yaml
routing:
  codex_reviews_patterns:
    - "Generated with \\[Claude Code\\]"
    - ".*"    # catch-all — Codex also reviews human PRs
```

**To skip certain branches**, filter in the webhook handler by adding routing conditions — or just don't register the webhook for that repo.

---

```yaml
# ── Server ────────────────────────────────────────────────────────────────────
server:
  port: 7891
  webhook_path: /webhook
```

| Field | Default | Notes |
|---|---|---|
| `port` | `7891` | Local port the webhook server listens on |
| `webhook_path` | `/webhook` | URL path for incoming webhook POST requests |

---

## Minimal config

The smallest valid config — everything else uses defaults:

```yaml
mode: cross-vendor
```

---

## Per-project vs global config

For teams using multiple repos, put a minimal config in each repo root (just `mode` and any repo-specific `routing` overrides), and keep shared defaults in `~/.crosscheck/config.yml`.

crosscheck merges them — repo-level config wins over home config for fields that are set in both.

> **Note:** Config merging across files is not yet implemented. Currently the first config file found is used in full. Home config and repo config must be kept in sync manually until this is added.
