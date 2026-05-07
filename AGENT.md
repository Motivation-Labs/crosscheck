# AGENT.md — crosscheck optimize harness

You are improving crosscheck's AI code review instructions. crosscheck runs `codex` and
`claude` CLIs to review pull requests automatically. Both reviewers read
`~/.crosscheck/instructions.md` before every review. Your job is to read the diagnostic
report below and produce an improved `instructions.md` that increases review quality and
reduces failures.

> **Note:** `crosscheck optimize` selects which agent runs you based on your local config
> and log history — whichever reviewer has the highest success rate, or `claude` if there
> is no data. The instructions you produce are reviewer-agnostic: they are read by both
> `claude` and `codex`, so write in plain language that both understand.

---

## Input you will receive

1. **Diagnostic JSON** from `crosscheck diagnose --json` — error patterns, review outcomes,
   repos seen, language signals, and suggestions.
2. **Current `instructions.md`** — may be empty on first run.

## Output you must produce

Respond with only the new content of `instructions.md`. No explanation, no preamble, no
markdown fences — just the file content. The file uses plain Markdown.

---

## Required sections (always present)

### `## Constraints`
What reviewers must NOT do. Each constraint is one bullet:
```
- Do not run [specific command].
```

### `## Focus`
What reviewers should prioritize. Free-form prose or bullets.

### `## Verdict format` (never modify this section)
This section must always be preserved exactly as written in the current file. If it is
missing from the current file, add it verbatim:

```markdown
## Verdict format

On the very last line of your response, write exactly one of:

VERDICT: APPROVE
VERDICT: NEEDS WORK
VERDICT: BLOCK

Use APPROVE for no issues or trivial nits only.
Use NEEDS WORK for addressable issues that are not blocking.
Use BLOCK for security risks, data loss, broken API contracts, or correctness bugs.
```

---

## Rules for the `## Constraints` section

### Add a constraint when
- `diagnostic.errors` contains a `command_not_found` pattern with `count >= 1` for a
  specific command.
- `diagnostic.errors` contains a `timeout` pattern with `count >= 2` for a reviewer that
  is also producing `command_not_found` entries (likely spinning on a failed tool call).

### Remove a constraint when
- It was previously added for a specific command but that command no longer appears in
  `diagnostic.errors` and has not appeared for the full log period analyzed.

### Phrasing rules
- Use the exact command name, not a category. Write `Do not run tsc.` not `Do not run
  TypeScript build tools.`
- One command per bullet. Do not combine: `Do not run tsc or npm.` → split into two.
- Do not restrict reading. `Do not open package.json` is wrong. Constraints are for
  execution only.
- Do not restrict security analysis. Never add a constraint that would prevent a reviewer
  from flagging a vulnerability.

---

## Language detection → constraint mapping

Use `diagnostic.languages_detected` (list of detected language/tool identifiers) to seed
the initial constraints. Add the corresponding constraint only if the language is detected
AND a related `command_not_found` error is present OR this is the first run with no
existing constraints.

| Detected signal | Constraint to add |
|---|---|
| `typescript` / `tsconfig.json` / `package.json` | `Do not run tsc.` |
| `nodejs` / `package.json` | `Do not run npm, npx, yarn, or pnpm.` |
| `jest` / `vitest` in devDependencies | `Do not run jest or vitest.` |
| `python` / `requirements.txt` / `pyproject.toml` | `Do not run pytest, pip, or python scripts.` |
| `rust` / `Cargo.toml` | `Do not run cargo build or cargo test.` |
| `go` / `go.mod` | `Do not run go build or go test.` |
| `java` / `pom.xml` | `Do not run mvn.` |
| `kotlin` / `gradle` / `build.gradle` | `Do not run gradle.` |
| `ruby` / `Gemfile` | `Do not run bundle exec or rspec.` |

Do not add constraints for languages not detected. Do not add all of the above blindly.

---

## Rules for the `## Focus` section

### Update focus when
- `diagnostic.verdict_distribution.APPROVE` percentage > 80% across >= 10 reviews → reviews
  may be too lenient → add: "Apply strict scrutiny to error handling and edge cases."
- `diagnostic.verdict_distribution.BLOCK` percentage > 30% across >= 10 reviews → reviews
  may be too strict → add: "Prefer NEEDS WORK over BLOCK unless the issue causes data loss
  or a security vulnerability."
- `diagnostic.repos_seen` consistently includes infrastructure repos (name contains
  `-infra`, `-deploy`, `-k8s`) → add: "Pay extra attention to secrets, env vars, and IAM
  permissions in infrastructure changes."

### Default focus (use when no signals override it)
```markdown
## Focus

Review for correctness, security, and maintainability. Flag issues that would cause bugs
in production, expose sensitive data, or make the code significantly harder to maintain.
Nits and style preferences should be NEEDS WORK, not BLOCK.
```

---

## Quality principles

1. **Minimal** — fewer instructions produce better reviews. Each line must earn its place.
2. **Specific** — exact command names, concrete criteria, not vague categories.
3. **Evidence-based** — add only what the diagnostic shows is needed or what language
   detection justifies.
4. **Reversible** — stale constraints (no matching errors in the log period) should be
   removed, not accumulated.
5. **Reviewer-agnostic** — these instructions are read by both `codex` and `claude`. Write
   them in plain language that both understand.

---

## What must never change

- The `## Verdict format` section content and label.
- Instructions that the user has manually annotated with `<!-- keep -->`.
- The overall Markdown structure (## headings, bullet lists).

---

## Worked example

### Input diagnostic (excerpt)
```json
{
  "summary": { "total_reviews": 6, "successful": 3, "failed": 3, "failure_rate": 0.5 },
  "errors": [
    { "pattern": "command_not_found", "command": "tsc", "count": 2, "reviewer": "codex" },
    { "pattern": "command_not_found", "command": "jest", "count": 1, "reviewer": "codex" },
    { "pattern": "base_branch_missing", "branch": "staging", "count": 2 }
  ],
  "verdict_distribution": { "APPROVE": 2, "NEEDS_WORK": 1, "BLOCK": 0 },
  "languages_detected": ["typescript", "nodejs"],
  "suggestions": [
    { "type": "add_constraint", "instruction": "Do not run tsc.", "reason": "tsc not found ×2" },
    { "type": "add_constraint", "instruction": "Do not run jest.", "reason": "jest not found ×1" }
  ]
}
```

### Input current instructions.md
```markdown
## Verdict format

On the very last line of your response, write exactly one of:
...
```

### Correct output
```markdown
## Constraints

- Do not run tsc.
- Do not run jest.
- Do not run npm, npx, yarn, or pnpm.

## Focus

Review for correctness, security, and maintainability. Flag issues that would cause bugs
in production, expose sensitive data, or make the code significantly harder to maintain.
Nits and style preferences should be NEEDS WORK, not BLOCK.

## Verdict format

On the very last line of your response, write exactly one of:

VERDICT: APPROVE
VERDICT: NEEDS WORK
VERDICT: BLOCK

Use APPROVE for no issues or trivial nits only.
Use NEEDS WORK for addressable issues that are not blocking.
Use BLOCK for security risks, data loss, broken API contracts, or correctness bugs.
```

Note: `Do not run npm, npx, yarn, or pnpm.` was added because `nodejs` was detected, even
though no npm error appeared yet — this is the language-detection pre-emptive path for
first-run seeding.
