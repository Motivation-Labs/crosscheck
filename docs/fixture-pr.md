# Fixture PR Plan

The fixture PR gives new users a safe, inspectable way to understand Crosscheck before trying it on production code.

## Repository

Create:

```text
humanbased-ai/crosscheck-proof-fixture
```

Use a small TypeScript service with:

- account transaction listing
- authenticated user context
- pagination
- one regression test covering tenant/user scoping

## Pull request

Title:

```text
Add account transaction pagination
```

The PR should look useful and plausible. It should add pagination to a transaction query while accidentally removing the authenticated user scope.

Bug shape:

```ts
// secure baseline
where: { accountId, ownerId: ctx.user.id }

// buggy PR
where: { accountId }
```

Expected risk:

```text
Any authenticated user can read another account's transactions by guessing accountId.
```

## PR timeline

The public timeline should contain:

1. Initial agent-authored feature commit.
2. Crosscheck review comment with `VERDICT: BLOCK`.
3. Crosscheck fix commit restoring user scope.
4. Regression test proving cross-user access is blocked.
5. Crosscheck recheck comment with `VERDICT: APPROVE`.

## User-facing first-run path

The first-run docs should recommend:

```bash
npm install -g @humanbased/crosscheck
gh auth login
codex login --device-auth
crosscheck status
crosscheck review https://github.com/humanbased-ai/crosscheck-proof-fixture/pull/1 --reviewer codex
```

Use `--reviewer claude` when Claude Code is the authenticated reviewer.

After review succeeds, the user can try:

```bash
crosscheck run https://github.com/humanbased-ai/crosscheck-proof-fixture/pull/1 --steps fix,recheck --fixer claude --reviewer codex
```

## Acceptance criteria

- The PR is public.
- The bug is realistic and easy to explain.
- The first review produces a merge-relevant finding.
- The fix is small and inspectable.
- The recheck closes the loop.
- The demo does not require `watch`, `serve`, tunnels, or webhooks.

## Publish commands

From the prepared fixture repository:

```bash
cd "/Users/beingzy/Documents/New project 2/crosscheck-proof-fixture"

gh repo create humanbased-ai/crosscheck-proof-fixture \
  --public \
  --source . \
  --remote origin \
  --description "Proof fixture for Crosscheck's review-fix-recheck demo" \
  --push

git push origin add-transaction-pagination

gh pr create \
  --base main \
  --head add-transaction-pagination \
  --title "Add account transaction pagination" \
  --body "This fixture PR intentionally adds pagination while dropping authenticated-user scoping, so Crosscheck can demonstrate a BLOCK -> fix -> recheck loop."
```

If GitHub CLI keyring auth times out, refresh auth with:

```bash
gh auth login
```
