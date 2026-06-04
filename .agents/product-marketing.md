# Product Marketing Context

*Last updated: 2026-06-03*

## Product Overview

**One-liner:** Crosscheck turns agent-written PRs into merge-ready patches.

**What it does:** Crosscheck runs a configurable Review -> Fix -> Recheck pipeline around AI-authored pull requests. It uses the local agent CLIs developers already use, such as Claude Code and Codex, so one agent can write a patch, another can review it, and the authoring agent can repair the finding before merge.

**Product category:** AI code review, agentic coding workflow, developer tool, CLI automation.

**Product type:** Open-source CLI and local/server workflow tool.

**Business model:** Open-source adoption first. Crosscheck is a public proof point for Humanbased's complete agentic software delivery commitment.

## Target Audience

**Target companies:** Solo builders, technical founders, small engineering teams, OSS maintainers, and AI-forward teams already using coding agents.

**Decision-makers:** Developer-user, technical founder, engineering lead, OSS maintainer.

**Primary use case:** Prevent plausible but incomplete AI-authored PRs from merging before an independent review, repair, and recheck loop has completed.

**Jobs to be done:**
- Add a merge-readiness loop to agent-authored PRs.
- Catch regressions, brittle fixes, and early-victory claims before merge.
- Keep agent speed while restoring engineering accountability.

**Use cases:**
- Review a specific PR with `crosscheck review <pr-url>`.
- Run review, fix, and recheck with `crosscheck run <pr-url>`.
- Monitor repos continuously with `crosscheck watch` or `crosscheck serve`.
- Operate stale PR queues with `crosscheck scan` and `crosscheck kickass`.

## Personas

| Persona | Cares about | Challenge | Value we promise |
| --- | --- | --- | --- |
| Solo agentic builder | Shipping fast without breaking main | Same agent that wrote the code may self-approve weak work | Independent review and recheck without new infrastructure |
| Technical founder | Output velocity and product correctness | AI PRs look done before they deliver stable value | Faster PR cycles with a visible merge-readiness loop |
| Engineering lead | Team standards and risk control | Agent use varies by developer and is hard to supervise | Configurable workflow, review-only mode, and repeatable gates |
| OSS maintainer | Reviewing community PRs efficiently | Review bandwidth is scarce and public comments must be useful | Local review comments that point to concrete, fixable findings |

## Problems & Pain Points

**Core problem:** Agent-written code can be plausible, fast, and still wrong. The common failure mode is not "no code"; it is early victory: a patch appears done before edge cases, regressions, and incomplete fixes have been checked.

**Why alternatives fall short:**
- Asking the same agent to review its own work lacks independence.
- Hosted AI review tools add another vendor, bill, and trust surface.
- Manual review alone is slower than the new PR volume agentic coding creates.
- Passing CI does not prove the PR solved the right problem.

**What it costs them:** Broken merges, review fatigue, lost trust in agents, and time spent repairing issues after the PR looked finished.

**Emotional tension:** Developers want agent speed but do not want to lower the merge bar.

## Competitive Landscape

**Direct:** AI code review tools and review bots. They fall short when they stop at comments instead of closing the loop through fix and recheck.

**Secondary:** GitHub Copilot review and model-native self-review. They fall short when the same workflow that created the patch is trusted to declare it ready.

**Indirect:** Manual code review and CI-only gates. They fall short when AI-generated PR volume outpaces human attention or when tests miss behavioral intent.

## Differentiation

**Key differentiators:**
- Review -> Fix -> Recheck loop, not review-only comments.
- Works through existing Claude Code and Codex CLI subscriptions.
- Local/server execution instead of a hosted review service.
- Configurable review-only, review+fix, and full loop modes.
- Public GitHub artifacts make PR workflow state visible.

**How we do it differently:** Crosscheck treats review as a workflow state machine. It reconstructs evidence from PR comments and commit trailers, then advances the PR to the next useful step.

**Why that's better:** The result is not just feedback. The PR moves toward merge-ready value.

**Why customers choose us:** They want agent velocity with independent scrutiny, minimal new infrastructure, and practical engineering accountability.

## Objections

| Objection | Response |
| --- | --- |
| "Why not ask the same agent to review?" | Crosscheck is built around independent review and recheck, because self-review is exactly where early-victory failures hide. |
| "Will this mutate my repo?" | Review-only mode is available. Fix and recheck are explicit workflow choices. |
| "Is this another hosted AI service?" | No. Crosscheck runs through local CLIs and existing subscriptions. |
| "Will this spam PRs?" | Crosscheck tracks workflow state through visible markers and only advances the configured next step. |

**Anti-persona:** Teams that do not use agentic coding yet, teams unwilling to run local CLIs, or teams that only want a generic hosted review bot.

## Switching Dynamics

**Push:** AI PRs are arriving faster than review habits can absorb.

**Pull:** A concrete loop that catches, fixes, and rechecks before merge.

**Habit:** Developers keep manually prompting agents or relying on CI because the setup feels simpler.

**Anxiety:** Users worry about agent permissions, accidental mutation, setup complexity, and public PR noise.

## Customer Language

**How they describe the problem:**
- "AI slop"
- "Early victory"
- "It looked done, but it broke something"
- "The agent says fixed too quickly"

**How they describe us:**
- "A second set of agent eyes"
- "A review/fix/recheck loop"
- "A merge-readiness gate for AI PRs"

**Words to use:** AI slop, agent-written PRs, merge-ready patches, Review -> Fix -> Recheck, early victory, independent review, local CLI.

**Words to avoid:** Fully autonomous merge, magic review, replaces engineers, guaranteed correctness.

## Brand Voice

**Tone:** Clear, practical, accountable.

**Style:** Direct engineering prose with concrete examples.

**Personality:** Human, careful, agent-native, craft-driven, skeptical of shallow "done" states.

## Proof Points

**Metrics:** Track activation and workflow completion over npm downloads: onboard completed, review completed, blocking finding posted, fix applied, recheck completed, weekly active repos.

**Customers:** Start with Humanbased dogfooding and OSS maintainers willing to share public PR examples.

**Testimonials:**
> Pending. Capture exact user language during Cycle 01.

**Value themes:**

| Theme | Proof |
| --- | --- |
| Catches AI slop | Demo PR shows a real regression caught by an independent reviewer |
| Closes the loop | Demo shows finding -> fix -> recheck, not just a comment |
| Keeps trust local | Docs explain local CLI execution, permissions, and review-only mode |
| Builds Humanbased credibility | Humanbased dogfooding report shows the same loop used to build Crosscheck |

## Goals

**Business goal:** Grow Crosscheck as a popular open-source tool and visible proof of Humanbased's complete agentic software delivery philosophy.

**Conversion action:** Install `@humanbased/crosscheck` and complete one useful review.

**Current metrics:** Establish in Cycle 01.
