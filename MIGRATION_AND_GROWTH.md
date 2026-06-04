# Crosscheck Migration and Growth Plan

Crosscheck is moving from `motivation-labs` to `humanbased-ai` because Humanbased is the primary brand to grow. The product should function as a public proof point: Humanbased builds practical, careful tools for the agentic coding era.

## Positioning

Crosscheck turns agent-written PRs into merge-ready patches.

The core pain is AI slop: code regressions, incomplete fixes, premature "done" states, weak self-review, and PRs that look plausible before they deliver solid value. Crosscheck adds a configurable Review -> Fix -> Recheck loop using the agent CLIs developers already pay for.

Primary audience:

- Engineers already using Claude Code, Codex, or both.
- Small teams letting agents open PRs.
- Technical founders who want speed without lowering the merge bar.

Primary promise:

> Move fast with AI agents without letting early-victory PRs reach main.

## Migration Runbook

1. Transfer GitHub repository:
   - Source: `Motivation-Labs/crosscheck`
   - Target: `humanbased-ai/crosscheck`
   - Preserve issues, PRs, releases, stars, Actions history, and redirects.

2. Update repository metadata:
   - Description: `AI code review pipeline that turns agent-written PRs into merge-ready patches`
   - Topics: `ai-code-review`, `claude-code`, `codex`, `ai-agents`, `agentic-coding`, `pull-request`, `github-webhooks`, `cli`, `devtools`, `code-quality`
   - Homepage: `https://github.com/humanbased-ai/crosscheck`

3. Move npm package identity:
   - New package: `@humanbased/crosscheck`
   - Fallback package if the preferred scope cannot be claimed: `@humanbased-ai/crosscheck`
   - Keep the CLI binaries as `crosscheck` and `ck`.
   - Ensure `NPM_TOKEN` can publish under the `@humanbased` scope before merging release workflow changes.
   - Confirm `npm owner ls @humanbased/crosscheck` after the first publish.

4. Publish the new npm package before deprecating the old one:
   - Run `npm publish --access public --tag latest` from a clean release build.
   - Verify `npm install -g @humanbased/crosscheck` installs the `crosscheck` and `ck` binaries.
   - Verify `npx @humanbased/crosscheck status` resolves the new package.
   - Update release and prerelease workflows only after the token has access to the new scope.

5. Deprecate old npm package after the new package is live:
   - Keep `@motivation-labs/crosscheck` available long enough for existing installs and lockfiles.
   - Deprecate old versions with:
     `npm deprecate "@motivation-labs/crosscheck@*" "Crosscheck has moved to @humanbased/crosscheck. Install with: npm install -g @humanbased/crosscheck"`
   - Do not unpublish the old package; npm unpublish rules and user lockfiles make that hostile to adoption.
   - If a final old-scope release is needed, make it a compatibility notice only and avoid changing the CLI behavior.
   - Keep GitHub redirects intact; do not delete the old org reference abruptly.

6. Verify:
   - `npm install -g @humanbased/crosscheck`
   - `crosscheck status`
   - `crosscheck review <fixture-pr> --dry-run`
   - GitHub issue filing routes to `humanbased-ai/crosscheck`.

## Launch Assets

### One-line description

Crosscheck is a local AI code review pipeline that turns agent-written PRs into merge-ready patches.

### Short launch post

AI coding agents are fast enough to create a new problem: PRs that look finished before they are safe to merge.

Crosscheck adds a Review -> Fix -> Recheck loop around Claude Code and Codex. One agent writes the patch, another reviews it, the author fixes the findings, and the reviewer checks again. It runs through the CLIs you already use, with no hosted review service and no per-review API bill.

Built by Humanbased to combat AI slop without slowing down the teams already shipping with agents.

### Demo script

1. Open with a real AI-authored PR that has a subtle regression.
2. Run `crosscheck review <pr-url>`.
3. Show the reviewer comment with a concrete blocking finding.
4. Run `crosscheck run <pr-url>` or show `watch` picking up the PR.
5. Show the fix commit and the recheck verdict.
6. End on the merged PR and the install command.

## 30-Day Growth Execution

Week 1:

- Complete GitHub and npm migration.
- Tighten README first screen around "AI slop -> merge-ready patch".
- Publish a 90-second demo video.
- Add a fixture repo or demo PR so users can try Crosscheck without risking production code.

Week 2:

- Write and publish the launch essay: "Stop Letting One Agent Review Its Own Code".
- Post demo clips to X, LinkedIn, Hacker News Show HN, `r/ClaudeAI`, `r/ChatGPTCoding`, and agentic coding communities.
- Ask every installer for first-run feedback in issues or discussions.

Week 3:

- Ship trust docs: permissions, webhook behavior, what leaves the machine, what Crosscheck can mutate, and how to run review-only.
- Add templates for "solo developer", "two-agent team", and "shared server" setups.
- Collect first public case study from the Humanbased workflow.

Week 4:

- Publish a follow-up with concrete dogfooding data: reviews run, blocking findings caught, regressions prevented, and time saved.
- Convert repeated questions into docs and onboarding improvements.
- Decide whether to launch on Product Hunt after the demo and first-run path are solid.

## Agentic Growth Design

Growth should run like Crosscheck itself: one agent ships a small growth asset or product improvement, a second agent evaluates it against evidence, and the first agent iterates before the work is promoted. The goal is not a single launch spike. The goal is a compounding proof system that shows Humanbased can turn agentic software work into complete, reviewed, merge-ready value.

### Operating cadence

- Weekly growth cycle: choose one user segment, one promise, one distribution channel, and one measurable conversion.
- Daily review: inspect installs, first-run failures, issues, stars, mentions, and demo engagement.
- Friday ship review: publish one improvement, one learning, and one next experiment.
- Monthly reset: retire weak channels, double down on what produced activated users, and update positioning from real user language.

### Growth agents

| Agent | Owns | Evaluates | Iterates when |
| --- | --- | --- | --- |
| Positioning Agent | Message, ICP, promise, objections | Does a developer understand Crosscheck in 10 seconds? | Users describe it as "another AI reviewer" instead of a review-fix-recheck loop |
| Onboarding Agent | Install, first command, fixture PR, docs | Can a new user reach a useful verdict in under 10 minutes? | Install succeeds but first review does not complete |
| Proof Agent | Demo PRs, screenshots, videos, dogfooding data | Does the asset show a real failure caught and fixed? | Viewers understand the tool but do not try it |
| Distribution Agent | GitHub, npm, topics, README, release notes | Can searchers discover the package by problem and tool name? | Traffic arrives but installs stay flat |
| Content Agent | Essays, tutorials, comparison posts, launch posts | Does the post attract the right builders and produce installs? | Engagement is high but activation is low |
| Community Agent | HN, X, LinkedIn, Reddit, Discord, issues | Are replies producing specific objections and use cases? | Attention creates debate but no qualified users |
| Trust Agent | Security, permissions, telemetry, mutation boundaries | Can cautious teams explain what Crosscheck can and cannot touch? | Users hesitate because agent permissions feel vague |
| Adoption Agent | Metrics, dashboards, issue labels, weekly report | Which step loses users: install, onboard, review, fix, or recheck? | Downloads rise without weekly active repos |
| Partnership Agent | Claude Code, Codex, devtool, agency, OSS maintainer channels | Does borrowed attention convert into owned audience? | Mentions create stars but no repeat usage |

### Step-by-step loop

#### Step 1: Sharpen the public promise

Builder agent: Positioning Agent.

Evaluator agent: Community Agent.

Ship:

- README first screen: "Stop merging AI slop. Turn agent-written PRs into merge-ready patches."
- One-line npm/GitHub description: "AI code review pipeline that turns agent-written PRs into merge-ready patches."
- Three buyer-specific variants:
  - Solo builder: "Let one agent write, another review, then recheck before merge."
  - Small team: "Add a merge gate for AI-authored PRs without buying another hosted review system."
  - Founder/CTO: "Keep agent velocity while restoring engineering accountability."

Evaluate:

- Five fresh developers should be able to answer: what is it, when would I use it, why not just ask the same agent to review?
- README visitors should click install, demo, or docs within the first screen.

Iterate:

- If users call it "AI code review", emphasize the full Review -> Fix -> Recheck pipeline.
- If users ask "why not GitHub Copilot review?", emphasize local agent CLIs, existing subscriptions, no per-review bill, and repair loop.

#### Step 2: Make first value undeniable

Builder agent: Onboarding Agent.

Evaluator agent: Adoption Agent.

Ship:

- `crosscheck init` path that creates a minimal working config.
- A public fixture PR with a real subtle regression and a known Crosscheck review result.
- A "try without production risk" guide.
- A 90-second terminal demo from install to recheck verdict.

Evaluate:

- New user reaches `review_completed` in under 10 minutes.
- At least 60% of onboarded users can explain the next step Crosscheck recommends.
- Top failure categories are visible in issues or opt-in telemetry.

Iterate:

- If install is the drop-off, improve npm package metadata, prerequisites, and CLI error messages.
- If review is the drop-off, add diagnosis for missing GitHub auth, missing agent CLI, invalid config, and inaccessible PR.
- If comprehension is the drop-off, replace abstract docs with one fixture walkthrough.

#### Step 3: Build proof before broad launch

Builder agent: Proof Agent.

Evaluator agent: Trust Agent.

Ship:

- Three proof assets:
  - "Regression caught" demo.
  - "Early victory fixed" demo.
  - "Review-only mode for cautious teams" demo.
- Dogfooding report from Humanbased:
  - reviews run
  - blocking findings caught
  - fix loops completed
  - rechecks passed
  - false positives worth improving

Evaluate:

- Every proof asset must show the starting PR, the finding, the fix, and the recheck.
- Trust Agent must verify the asset does not imply unsafe mutation or hidden hosted review.

Iterate:

- If demos look scripted, use real merged PRs with sensitive details removed.
- If the tool seems risky, lead with review-only and permission boundaries.

#### Step 4: Own the category language

Builder agent: Content Agent.

Evaluator agent: Positioning Agent.

Ship:

- Pillar essay: "Stop Letting One Agent Review Its Own Code."
- Practical guide: "How to Add a Review -> Fix -> Recheck Loop to Claude Code and Codex."
- Comparison post: "AI Code Review vs Agentic PR Repair."
- Problem post: "Early Victory PRs: Why Agent-Written Code Looks Done Before It Is."
- Template page: "Crosscheck workflow.yml examples."

Evaluate:

- Content must be either searchable, shareable, or both.
- Every piece must drive to one action: install, run fixture demo, or join updates.
- Message must tie Crosscheck back to Humanbased's commitment to complete agentic software delivery.

Iterate:

- If search traffic is weak, rewrite titles around exact user queries.
- If social sharing is weak, add sharper claims, real examples, and dogfooding data.
- If traffic does not activate, move install and fixture demo higher.

#### Step 5: Convert migration into a trust moment

Builder agent: Distribution Agent.

Evaluator agent: Trust Agent.

Ship:

- Old npm scope deprecation notice pointing to `@humanbased/crosscheck`.
- Release notes explaining the migration, continuity, and package identity.
- GitHub pinned issue: "Crosscheck has moved to Humanbased."
- README badge or note for the first few weeks after migration.

Evaluate:

- Existing users can identify the new package and GitHub repo without ambiguity.
- No one is surprised by package continuity, version continuity, or old-scope sunset timing.

Iterate:

- If users keep installing the old scope, strengthen npm deprecation message and README migration note.
- If users worry about ownership change, explain Humanbased PTE LTD as the responsible party and Humanbased as the product brand.

#### Step 6: Launch in narrow communities first

Builder agent: Community Agent.

Evaluator agent: Adoption Agent.

Ship:

- One discussion-first post per community:
  - Hacker News: practical demo and "Show HN" only after first-run path is solid.
  - X and LinkedIn: demo clips, failure examples, engineering craft angle.
  - Reddit and Discord communities: ask for workflow critique, not generic promotion.
  - GitHub Discussions: invite fixture PR results and bug reports.

Evaluate:

- Count activated users, not likes.
- Tag every useful reply as objection, use case, bug, competitor, or testimonial.
- Measure which community produces completed reviews.

Iterate:

- If people debate the concept but do not try it, post a smaller "run this fixture PR" challenge.
- If people try it and fail, ship fixes before the next community post.
- If a segment activates, write the next post specifically for that segment.

#### Step 7: Turn usage into product-led loops

Builder agent: Onboarding Agent.

Evaluator agent: Adoption Agent.

Ship:

- Better end-of-run summary with next recommended command.
- Optional shareable review summary for public OSS PRs.
- Issue templates that capture environment, agent CLI, PR URL shape, workflow mode, and failure category.
- Examples for solo, team, review-only, and webhook-driven workflows.

Evaluate:

- Completed review should naturally lead to fix or recheck.
- Public OSS use should create visible GitHub comments that explain Crosscheck's value without being spammy.
- Repeated issues should collapse into docs, diagnostics, or defaults.

Iterate:

- If users stop after review, make the next command obvious.
- If users do not understand findings, improve comment format.
- If users fear automation, make review-only the obvious conservative mode.

#### Step 8: Add borrowed-audience partnerships

Builder agent: Partnership Agent.

Evaluator agent: Content Agent.

Ship:

- Outreach to agentic coding newsletter writers, OSS maintainers using agents, Claude Code/Codex tutorial creators, and engineering founders.
- Co-created demos: "We let an agent write this PR, then Crosscheck forced it to become merge-ready."
- Case study template for teams willing to share their workflow.

Evaluate:

- Borrowed audience must convert into owned audience: GitHub watchers, email subscribers, discussions, or repeat users.
- Partner content should produce at least one qualified conversation or issue.

Iterate:

- If partner content creates shallow attention, switch to hands-on workflow teardown.
- If maintainers are interested but busy, offer to run Crosscheck on one public PR and send findings.

#### Step 9: Build the growth dashboard

Builder agent: Adoption Agent.

Evaluator agent: Positioning Agent.

Ship:

- Weekly growth report:
  - npm installs by package scope
  - GitHub stars and forks
  - unique repos reviewed
  - onboard started/completed
  - review/fix/recheck completion
  - first-run failure categories
  - top acquisition source
  - top user quote
- Issue labels:
  - `activation-blocker`
  - `trust-objection`
  - `docs-gap`
  - `demo-gap`
  - `workflow-template`
  - `distribution-signal`

Evaluate:

- The report must identify one bottleneck and one next experiment every week.
- Metrics must separate vanity attention from activated usage.

Iterate:

- If dashboards grow but decisions do not improve, cut metrics.
- If downloads rise but active repos do not, prioritize onboarding and docs over more launch posts.

#### Step 10: Relaunch every product improvement

Builder agent: Distribution Agent.

Evaluator agent: Proof Agent.

Ship:

- Release notes written as user outcomes, not changelog fragments.
- Short demo clip for every meaningful feature.
- "What this catches now" examples for review logic improvements.
- Monthly Humanbased engineering note showing how Crosscheck improved its own development loop.

Evaluate:

- Each release should explain: what risk it reduces, what workflow it improves, and how to try it.
- Proof Agent must verify claims against real examples before publishing.

Iterate:

- If release notes get ignored, lead with before/after screenshots or terminal output.
- If users miss new capabilities, add first-run hints and examples.

### Stage gates

| Stage | Goal | Gate to advance | If blocked |
| --- | --- | --- | --- |
| Foundation | Clear identity and migration trust | Users can install `@humanbased/crosscheck` and understand the move | Fix package metadata, deprecation copy, README first screen |
| Activation | First useful review | New user completes a fixture review in under 10 minutes | Improve init, auth checks, diagnostics, and demo PR |
| Proof | Credible value | Public demos show real bugs caught, fixed, and rechecked | Dogfood more real PRs and publish concrete cases |
| Distribution | Repeatable acquisition | One channel produces activated users weekly | Narrow the audience and rewrite the offer |
| Retention | Repeat usage | Users run Crosscheck on more than one PR or repo | Improve summaries, workflow templates, watch mode, and integrations |
| Category | Humanbased association | People connect Crosscheck with complete agentic software delivery | Publish Humanbased engineering notes and case studies |

### Weekly review template

```markdown
## Crosscheck Growth Review: YYYY-MM-DD

### This week's bet
- Segment:
- Promise:
- Channel:
- Asset or product change:
- Expected user action:

### Evidence
- Installs:
- Onboard completed:
- Reviews completed:
- Fix loops completed:
- Rechecks completed:
- Weekly active repos:
- Top failure category:
- Best user quote:

### Agent reviews
- Positioning Agent:
- Onboarding Agent:
- Proof Agent:
- Distribution Agent:
- Trust Agent:
- Adoption Agent:

### Decision
- Double down:
- Iterate:
- Stop:
- Next experiment:
```

## Adoption Metrics

Do not use npm downloads as the main success metric; prerelease publishing and registry scanners inflate it.

Track these instead:

- `onboard_started`
- `onboard_completed`
- `review_started`
- `review_completed`
- `blocking_finding_posted`
- `fix_applied`
- `recheck_completed`
- weekly active repos
- first-run failure category
- time from PR open to review verdict

Telemetry must be opt-in and documented clearly.
