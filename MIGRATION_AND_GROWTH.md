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
