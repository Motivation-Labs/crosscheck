# AGENTS.md — crosscheck

## Workflow (mandatory)

### 1. Before writing any code

- Read the request. If ambiguous, ask — do not guess.
- Read the relevant source files to understand current state.
- Identify: which files change, what new files are needed, whether the public CLI API changes.

### 2. Branch

Always work on a feature branch. Never commit directly to `main`.

**Use the `codex/` prefix** so crosscheck can identify Codex-authored PRs for cross-review routing:

```bash
git checkout -b codex/<short-description>
```

Only use non-`codex/` prefixes when the branch convention is documented separately.

### 3. Build

For every change:

1. Implement the feature or fix.
2. Run the quality gate — all must pass before committing:

```bash
npm run typecheck   # zero type errors
npm run build       # clean compile to dist/
```

3. Self-review every changed file: unused imports, broken references, incorrect types.

### 4. Commit

Use conventional commits:

```
feat: add --dry-run flag to review command
fix: codex review exits non-zero on empty diff
chore: update smee-client to 2.1.0
refactor: extract PR clone logic into shared helper
test: add edge cases for origin detector
```

One logical change per commit. Do not batch unrelated changes.

### 5. PR

Push the branch and open a PR targeting **`staging`** — never `main`.

```bash
gh pr create --base staging
```

Every PR must include:

- **What changed** — one-paragraph summary
- **Why** — the problem it solves or the capability it adds
- **How to test** — exact commands to verify the change
- **Attribution line** at the end of the body (required for cross-review routing):

```
⚡ Generated with [OpenAI Codex](https://openai.com/codex)
```

Do not merge the PR yourself.

### 6. Branch flow

```
feature branch → staging → main
```

| Branch | Purpose | How to get there |
|---|---|---|
| `codex/*` | Active development | PR → `staging` |
| `staging` | Integration + pre-release validation | PR → `main` when ready |
| `main` | Production — triggers `@latest` npm publish | Merge from `staging` only |

---

## Project structure

```
src/
  cli.ts                  # Entry point — command definitions only, no logic
  commands/               # One file per CLI command
  config/
    schema.ts             # Zod schema — single source of truth for config shape
    loader.ts             # File discovery, parsing, env var access
  github/
    client.ts             # GitHub API calls
    detector.ts           # PR origin detection and reviewer assignment
    webhook.ts            # HTTP server for incoming webhook events
crosscheck.config.example.yml   # Canonical example — keep in sync with schema.ts
```

### Rules

- `cli.ts` only wires commands to handlers — no business logic
- `schema.ts` is the authority on config shape; `loader.ts` reads it, nothing else defines config types
- GitHub API calls go through `client.ts` — no raw `fetch` to `api.github.com` elsewhere

---

## Code standards

- TypeScript `strict: true` — no `any`, no `@ts-ignore`
- Explicit return types on all exported functions
- Use `unknown` for caught errors, narrow before accessing properties
- All I/O is `async`/`await` — no callbacks
- Parallel where independent: `await Promise.all([...])`
- Never `await` inside a loop — batch with `Promise.all`

---

## CLI API contract

The public CLI surface is: command names, flag names, and exit codes. Any change is a
breaking change and requires a major version bump.

| Exit code | Meaning |
|---|---|
| `0` | Success |
| `1` | User error |
| `2` | Unexpected error |

---

## Config schema contract

Any change to `crosscheck.config.yml` schema must:

1. Update `schema.ts` (add a default so old configs stay valid)
2. Update `crosscheck.config.example.yml`
3. Update the **Configuration** section of `get-started.md`

Never remove a config field or change its type — that is a breaking change.
