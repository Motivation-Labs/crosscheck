# Cycle 01 Assets

These are the first assets to build, evaluate, and iterate before broad distribution.

## Asset 1: Try Without Production Risk

Builder agent: Onboarding Agent.

Evaluator agent: Adoption Agent.

### Goal

Let a new user prove Crosscheck on one controlled PR before connecting it to a real production workflow.

### Draft flow

```bash
npm install -g @humanbased/crosscheck
crosscheck status
crosscheck onboard
crosscheck review https://github.com/humanbased-ai/crosscheck-proof-fixture/pull/1 --reviewer codex
```

If a public fixture repo is not ready yet, use a friendly user's real PR and label the guide "Bring one safe PR".

### Required fixture behavior

- The PR should contain one realistic AI-slop failure:
  - subtle regression
  - incomplete edge-case handling
  - premature "fixed" state
- The expected review should produce one blocking or needs-work finding.
- The fixture should include a follow-up fix commit.
- The recheck should approve or clearly explain the remaining gap.

### Evaluation

- A new user knows the prerequisites before running the command.
- The command path does not require watch mode, webhooks, or team setup.
- Failure modes point to one next action.
- The output makes the Review -> Fix -> Recheck concept visible.

### Iterate when

- Users ask which PR to use.
- Users get blocked by GitHub or agent CLI auth.
- Users complete review but do not understand how to run fix/recheck.

## Asset 2: Proof Demo

Builder agent: Proof Agent.

Evaluator agent: Trust Agent.

### Goal

Show Crosscheck turning a plausible AI-authored PR into a merge-ready patch.

### 90-second script

1. Show the PR title and diff. Say: "This PR looks done, but it has a subtle regression."
2. Run:

   ```bash
   crosscheck review <fixture-pr-url> --reviewer codex
   ```

3. Show the GitHub review comment with the concrete blocking finding.
4. Run:

   ```bash
   crosscheck run <fixture-pr-url> --steps fix,recheck --fixer claude --reviewer codex
   ```

5. Show the fix commit.
6. Show the recheck verdict.
7. End with:

   ```bash
   npm install -g @humanbased/crosscheck
   ```

### Launch-ready proof checklist

- Shows the starting bug.
- Shows the Crosscheck finding.
- Shows the fix.
- Shows the recheck.
- Uses Humanbased wording once, lightly: "Built by Humanbased for complete agentic software delivery."
- Does not imply fully autonomous merge or guaranteed correctness.

### Iterate when

- The demo looks like a toy.
- The finding is too vague.
- The fix/recheck part is missing or rushed.
- Viewers understand the concept but do not know what to run.

## Asset 3: Narrow Distribution Kit

Builder agent: Distribution Agent.

Evaluator agent: Community Agent.

### Goal

Invite the right builders to run the fixture/demo path and report where it breaks.

### GitHub pinned issue draft

```markdown
# Crosscheck has moved to Humanbased

Crosscheck now lives at `@humanbased/crosscheck` and `github.com/humanbased-ai/crosscheck`.

The mission is the same and sharper: combat AI slop by turning agent-written PRs into merge-ready patches through a Review -> Fix -> Recheck loop.

Install:

```bash
npm install -g @humanbased/crosscheck
```

For the first growth cycle, we are looking for feedback on one thing:

Can you complete one useful review in under 10 minutes?

Please share:
- your agent CLI setup
- the command you ran
- where you got stuck
- whether the review finding was useful
```

### X / LinkedIn post draft

```text
AI coding agents are fast enough to create a new failure mode: PRs that look done before they are safe to merge.

Crosscheck adds an independent Review -> Fix -> Recheck loop around Claude Code and Codex.

One agent writes. Another reviews. The author fixes. The reviewer checks again.

Install:
npm install -g @humanbased/crosscheck

Built by Humanbased for complete agentic software delivery.
```

### Hacker News / Show HN draft

```text
Show HN: Crosscheck - a Review -> Fix -> Recheck loop for agent-written PRs

AI coding agents often produce PRs that look finished before they are actually merge-ready. Crosscheck is an open-source CLI that runs an independent review/fix/recheck workflow using the agent CLIs developers already have, such as Claude Code and Codex.

The goal is not to replace engineers or auto-merge code. It is to add a practical safety loop around agent-authored PRs: review the patch, send findings back for repair, then recheck the result.

Install:
npm install -g @humanbased/crosscheck

I would especially like feedback from people already using agents to create PRs:
- What breaks in first setup?
- Does the review comment catch something useful?
- Would review-only mode be enough to start?
```

### Reddit / Discord-style post draft

```text
I'm looking for workflow critique from people using Claude Code, Codex, or other coding agents on real PRs.

Crosscheck is an open-source CLI from Humanbased that adds a Review -> Fix -> Recheck loop around agent-written PRs. The use case is catching "early victory" PRs: patches that look done but still have regressions, missing edge cases, or shallow fixes.

The thing I want to validate first is activation:
Can a new user get one useful review verdict in under 10 minutes?

Install:
npm install -g @humanbased/crosscheck

What would make you trust or reject this workflow?
```

### Evaluation

- Each post asks for a concrete action.
- Each post leads to install, fixture/demo path, or a specific critique.
- Each reply is tagged as objection, use case, bug, competitor, testimonial, or noise.

### Iterate when

- Replies debate the concept but nobody runs it.
- Users install but fail before review.
- Users ask about trust boundaries.
- People mistake Crosscheck for hosted AI review.
