# CLAUDE.md — crosscheck

## Workflow (mandatory)

### 1. Before writing any code

- Read the request. If it's ambiguous, ask — don't guess.
- Read the relevant source files to understand current state.
- Identify: which files change, what new files are needed, whether the public CLI API changes.

### 2. Branch

Always work on a feature branch. Never commit directly to `main`.

```bash
git checkout -b feat/<short-description>
git checkout -b fix/<short-description>
```

### 3. Build

For every change:

1. Implement the feature or fix.
2. Run the quality gate — all three must pass before committing:

```bash
npm run typecheck   # zero type errors
npm run build       # clean compile to dist/
```

3. Self-review every changed file: unused imports, broken references, incorrect types.
4. Adversarial check: what input or state would break this? Test it.

### 4. Commit

Use conventional commits:

```
feat: add --dry-run flag to review command
fix: codex review exits non-zero on empty diff
chore: update smee-client to 2.1.0
docs: document routing pattern examples
refactor: extract PR clone logic into shared helper
test: add edge cases for origin detector
```

One logical change per commit. Do not batch unrelated changes.

### 5. PR

Push the branch and open a PR targeting `main`. Every PR must include:

- **What changed** — one-paragraph summary
- **Why** — the problem it solves or the capability it adds
- **How to test** — exact commands to verify the change

Do not merge the PR yourself.

### Enforcement

- **Never commit directly to `main`**
- **Never open a PR with failing typecheck or build**
- **Never ship a breaking change to the CLI API without a major version bump**

---

## Project structure

```
src/
  cli.ts                  # Entry point — command definitions only, no logic
  commands/
    init.ts               # crosscheck init
    review.ts             # crosscheck review <pr-url>
    watch.ts              # crosscheck watch
    serve.ts              # crosscheck serve
    status.ts             # crosscheck status
  config/
    schema.ts             # Zod schema — single source of truth for config shape
    loader.ts             # File discovery, parsing, env var access
  github/
    client.ts             # Octokit wrapper, webhook signature verification
    detector.ts           # PR origin detection and reviewer assignment
    webhook.ts            # HTTP server for incoming webhook events
  reviewers/
    codex.ts              # codex CLI runner
    claude.ts             # claude CLI runner
crosscheck.config.example.yml   # Canonical example — keep in sync with schema.ts
get-started.md                  # Single-file documentation
```

### Rules

- `cli.ts` only wires commands to handlers — no business logic
- `schema.ts` is the authority on config shape; `loader.ts` reads it, nothing else defines config types
- Each `commands/` file owns one command end-to-end
- Reviewer runners (`codex.ts`, `claude.ts`) are pure functions: take inputs, return review text, throw on failure
- GitHub API calls go through `client.ts` — no raw `fetch` to `api.github.com` elsewhere

---

## Code standards

**TypeScript**
- `strict: true` — no exceptions
- No `any`, no `@ts-ignore`, no `as unknown as X` casts without a comment explaining why
- Explicit return types on all exported functions
- Use `unknown` for caught errors, narrow before accessing properties

**Error handling**
- Throw real `Error` objects with descriptive messages
- Catch at the command boundary (`commands/*.ts`), not inside utilities
- User-facing errors: print with `chalk.red()` and `process.exit(1)`
- Never swallow errors silently

**Dependencies**
- Do not add a dependency for something that can be done in 10 lines of stdlib
- Prefer `execa` over `child_process.exec` for spawning CLIs
- Do not import from `dist/` — always import from `src/`

**Async**
- All I/O is `async`/`await` — no callbacks
- Parallel where independent: `await Promise.all([...])`
- Never `await` inside a loop — batch with `Promise.all`

---

## CLI API contract

The public CLI surface is: command names, flag names, and exit codes.

Any change to these is a **breaking change** and requires a major version bump (`npm version major`).

| Exit code | Meaning |
|---|---|
| `0` | Success |
| `1` | User error (bad args, missing env var, auth failure) |
| `2` | Unexpected error (network failure, CLI crash) |

New flags must be additive and optional. Flags may not be renamed.

---

## Config schema contract

`crosscheck.config.yml` is read and written by users and agents. Any change to the schema must:

1. Update `schema.ts` with the new field (add a default so old configs stay valid)
2. Update `crosscheck.config.example.yml` with the new field, commented
3. Update the **Configuration** section of `get-started.md`

Never remove a config field or change its type — that is a breaking change.

---

## Environment variables

| Variable | Required | Used by |
|---|---|---|
| `GITHUB_TOKEN` | All commands that call GitHub API | `client.ts`, `watch.ts` |
| `CROSSCHECK_WEBHOOK_SECRET` | `serve`, `watch` | `webhook.ts` |
| `GITHUB_WEBHOOK_SECRET` | Alias for above | `loader.ts` |

Never read env vars outside `config/loader.ts`.

---

## Versioning

Follow semver strictly.

| Change | Version bump |
|---|---|
| New command or flag | `minor` |
| Bug fix, internal refactor | `patch` |
| Removed/renamed command, flag, or config field | `major` |

Before publishing: `npm run typecheck && npm run build && npm version <patch|minor|major> && npm publish`
