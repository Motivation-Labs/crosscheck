# Changelog

All notable changes to crosscheck will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] — 2025

### Initial release

#### Commands

- **`crosscheck init`** — Environment check and config generation. Verifies that required CLI tools (`gh`, `claude`, `codex`) are installed and authenticated, then writes a starter `crosscheck.config.yml` with sensible defaults.

- **`crosscheck review <pr-url>`** — Manual one-shot PR review. Clones the target repo, checks out the PR branch, and dispatches the review to the configured AI reviewer. Accepts `--reviewer codex|claude` to force a specific vendor, bypassing auto-detection.

- **`crosscheck watch`** — Local dev mode with auto-managed smee.io tunnel. Registers a temporary GitHub webhook on the current repo, listens for `pull_request` events, and automatically deduplicates in-flight reviews so the same PR is never reviewed twice concurrently.

- **`crosscheck serve`** *(BETA)* — Always-on webhook server for mac-mini or home-server deployments. Accepts incoming GitHub webhook payloads directly (no smee tunnel), handles deduplication, and keeps running until `SIGINT`.

- **`crosscheck status`** — Auth and config snapshot. Displays the current authentication state for GitHub (`gh`), Claude Code, and Codex, alongside a summary of the active config file.

#### Core features

- **Cross-vendor mode** — When both Codex and Claude Code are configured, crosscheck auto-detects the origin of each PR (e.g. Codex-generated vs human-authored) and routes to the appropriate reviewer for reciprocal review.

- **Single-vendor mode** — Works with only one reviewer configured; routes all PRs to the available vendor.

- **Subscription auth support** — Supports both API-key and subscription (OAuth/browser-based) authentication for Claude Code and Codex, so teams without pay-as-you-go billing can still use crosscheck.

- **Quality tiers** — Configurable review depth (`light`, `standard`, `thorough`) with per-review USD budget cap for API-key modes.

- **Webhook deduplication** — In-flight review keys (`owner/repo#pr@sha`) prevent duplicate reviews from rapid-fire webhook deliveries.

- **GitHub PR comment posting** — Review output is posted directly as a PR review comment via the GitHub API using Octokit.
