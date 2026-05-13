<div align="right">
  <h5><a href="./get-started.md">🌐 &nbsp;English</a></h5>
</div>

# crosscheck — 快速上手

## 目录

- [前提条件](#前提条件)
- [安装](#安装)
- [环境变量](#环境变量)
- [第一步 — 检查环境](#第一步--检查环境)
- [第二步 — 用单个 PR 测试](#第二步--用单个-pr-测试)
- [第三步 — 选择部署模式](#第三步--选择部署模式)
- [第四步 — 验证运行正常](#第四步--验证运行正常)
- [命令](#命令)
  - [init](#crosscheck-init)
  - [review](#crosscheck-review-pr-url)
  - [watch](#crosscheck-watch)
  - [serve](#crosscheck-serve-beta)
  - [status](#crosscheck-status)
  - [diagnose](#crosscheck-diagnose)
  - [optimize](#crosscheck-optimize)
  - [impact](#crosscheck-impact)
- [配置](#配置)
- [工作原理](#工作原理)
- [常见问题](#常见问题)

---

## 前提条件

运行 crosscheck 之前，你需要安装并认证以下三个 CLI 工具。

### Claude Code

```bash
npm install -g @anthropic-ai/claude-code
claude   # 按提示登录 claude.ai
```

需要 Claude Pro 或 Max 订阅计划。审查使用你的订阅配额，无需按 token 计费。

### Codex

```bash
npm install -g @openai/codex
codex login --device-auth   # 使用 ChatGPT 账号 OAuth 登录
```

需要 ChatGPT Plus 或 Pro 订阅。通过 `--device-auth` 认证后，审查消耗订阅配额，无需 API Key。

如果你更倾向于使用 OpenAI API Key：

```bash
printenv OPENAI_API_KEY | codex login --with-api-key
```

然后在配置中设置 `auth: api-key` 以启用模型选择。

### GitHub CLI

```bash
brew install gh       # macOS
gh auth login
```

用于克隆 PR 分支，在 watch 模式下自动注册 Webhook。

---

## 安装

**稳定版（推荐）：**

```bash
npm install -g @motivation-labs/crosscheck
```

**Beta 版（最新特性，可能存在问题）：**

```bash
npm install -g @motivation-labs/crosscheck@beta
```

**npx — 无需安装：**

```bash
npx @motivation-labs/crosscheck <命令>
npx @motivation-labs/crosscheck@beta <命令>
```

**从源码安装：**

```bash
git clone https://github.com/Motivation-Labs/crosscheck
cd crosscheck
npm install && npm run build && npm link
```

---

## 环境变量

### GitHub 认证 — 两种方式（选其一）

**方式一 — gh CLI（推荐）：** 认证一次，crosscheck 自动获取 Token：

```bash
gh auth login
```

**方式二 — Personal Access Token：** 适合 CI 环境或偏好显式 Token：

```bash
export GITHUB_TOKEN=ghp_...
```

Classic PAT 需要 `repo` 和 `admin:org_hook` 权限（Org 级别 Webhook 需要 `admin:org_hook`；仅 Repo 级别只需 `repo`）。
在 [github.com/settings/tokens](https://github.com/settings/tokens) 生成。

如果两者都存在，crosscheck 优先使用 `gh` keyring 中的 Token（始终最新），以 `GITHUB_TOKEN` 为备选。

### Webhook Secret — 自动管理

`CROSSCHECK_WEBHOOK_SECRET` 是**可选的**。如果未设置，crosscheck 会在首次使用时生成一个随机 Secret，保存到 `~/.crosscheck/webhook-secret`（仅本人可读），之后每次运行自动复用。

稍后查询（例如需要手动注册 Webhook 时）：

```bash
cat ~/.crosscheck/webhook-secret
```

如需使用自定义 Secret，在 shell 配置文件中设置：

```bash
export CROSSCHECK_WEBHOOK_SECRET=your-secret
```

---

## 第一步 — 检查环境

```bash
crosscheck init
```

扫描你的机器，报告每个依赖项的状态，并在当前目录生成一个初始 `crosscheck.config.yml`。

```
crosscheck — environment check

  ✓ codex CLI            codex-cli 0.128.0 — authenticated
  ✓ claude CLI           2.1.x (Claude Code)
  ✓ gh CLI               gh version 2.65.0
  ✓ GITHUB_TOKEN         set (gh auth login)
  ✓ WEBHOOK_SECRET       auto-managed at ~/.crosscheck/webhook-secret
```

修复所有失败项后再继续。

---

## 第二步 — 用单个 PR 测试

最快的端到端验证方式：

```bash
crosscheck review https://github.com/owner/repo/pull/123 --reviewer codex
```

此命令会克隆 PR 分支，运行 Codex 审查，并在 PR 中发布评论。如果无报错完成，说明你的配置正常。

也可以用 Claude 作为审查者：

```bash
crosscheck review https://github.com/owner/repo/pull/123 --reviewer claude
```

---

## 第三步 — 选择部署模式

### Watch 模式 — 适合开发机器

启动本地服务器，通过 `localhost.run`（SSH，无需额外安装）开通公网隧道，让 GitHub 能访问你的本地机器。自动注册 Webhook，支持 Org 级或 Repo 级覆盖，终端开启期间持续运行。

```bash
# 监控整个 Org（在 crosscheck.config.yml 中配置）
crosscheck watch

# 或在仓库目录内运行 — 自动从 git remote 检测
cd /path/to/your/repo && crosscheck watch
```

```
crosscheck watch

  orgs      motivation-labs, codatta
  mode      cross-vendor
  quality   balanced
  config    ./crosscheck.config.yml  ← 编辑可修改以上配置

  ✓ tunnel ready: https://abc123.lhr.life
  tunnel    https://abc123.lhr.life
  ✓ webhook registered for motivation-labs

Waiting for PR events — Ctrl+C to stop.
```

按下 `Ctrl+C` 后，SSH 隧道和已注册的 Webhook 会自动清理。

**Org Webhook 所需 Token 权限：** `GITHUB_TOKEN` 需要 `write:org` 权限用于 Org 级覆盖，Repo 级只需 `repo` 权限。

### Serve 模式 [BETA] — 适合常驻机器（mac-mini、家庭服务器）

> **Beta：** `serve` 功能可用，但尚未经过充分生产验证。欢迎在 [github.com/Motivation-Labs/crosscheck/issues](https://github.com/Motivation-Labs/crosscheck/issues) 报告问题。

监听固定端口，Webhook 只需手动注册一次，永久生效。

```bash
crosscheck serve
```

```
crosscheck serving
⚠  serve is in beta — report issues at github.com/Motivation-Labs/crosscheck/issues

  mode      cross-vendor
  quality   balanced
  port      7891
  endpoint  http://your-machine.local:7891/webhook

Register the endpoint above as a GitHub org webhook (content-type: application/json).
  → https://github.com/organizations/motivation-labs/settings/hooks
  → https://github.com/organizations/codatta/settings/hooks
```

**Org 级覆盖**（覆盖 Org 下所有仓库），在以下位置注册：
`https://github.com/organizations/<org>/settings/hooks`

**Repo 级覆盖**，在以下位置注册：
`https://github.com/<owner>/<repo>/settings/hooks`

- Payload URL：`http://your-machine:7891/webhook`
- Content type：`application/json`
- Secret：`CROSSCHECK_WEBHOOK_SECRET` 的值
- 触发事件：仅 **Pull requests**

**macOS launchd 后台服务配置：**

```xml
<!-- ~/Library/LaunchAgents/dev.crosscheck.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.crosscheck</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/crosscheck</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GITHUB_TOKEN</key><string>ghp_your_token</string>
    <key>CROSSCHECK_WEBHOOK_SECRET</key><string>your_secret</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/crosscheck.log</string>
  <key>StandardErrorPath</key><string>/tmp/crosscheck.error.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/dev.crosscheck.plist
launchctl start dev.crosscheck
```

**pm2 运行（跨平台）：**

```bash
npm install -g pm2
pm2 start crosscheck -- serve
pm2 save && pm2 startup
```

---

## 第四步 — 验证运行正常

提交一个 PR（或向已有 PR 推送）。你应该看到：

1. 事件到达时，终端中出现日志行
2. 约 60 秒内，PR 中发布代码审查评论

如果没有出现，运行 `crosscheck status` 检查认证和配置，然后在 GitHub 的 `Settings → Webhooks → Recent Deliveries` 查看 Webhook 投递日志。

---

## 命令

### `crosscheck init`

检查环境并生成初始配置文件。

```bash
crosscheck init
crosscheck init --config /path/to/crosscheck.config.yml
```

检查内容：`codex` CLI、`claude` CLI、`gh` CLI、`GITHUB_TOKEN`、`CROSSCHECK_WEBHOOK_SECRET`。

| 参数 | 说明 |
|---|---|
| `-c, --config <path>` | 将配置文件写入指定路径 |

---

### `crosscheck review <pr-url>`

手动触发对单个 PR 的审查。

```bash
crosscheck review https://github.com/owner/repo/pull/123
crosscheck review https://github.com/owner/repo/pull/123 --reviewer codex
crosscheck review https://github.com/owner/repo/pull/123 --reviewer claude
```

| 参数 | 说明 |
|---|---|
| `-r, --reviewer codex\|claude` | 跳过自动检测，强制使用指定审查者 |
| `-c, --config <path>` | 使用指定配置文件 |

---

### `crosscheck watch`

本地开发模式。自动创建隧道，注册 Webhook，退出时自动清理。

```bash
cd /path/to/your/repo
crosscheck watch
```

使用 `localhost.run`（SSH）开通公网隧道——SSH 在 macOS/Linux 预装，无需额外安装或注册账号。Org 级覆盖需要 `GITHUB_TOKEN` 拥有 `write:org` 权限，Repo 级只需 `repo` 权限。

| 参数 | 说明 |
|---|---|
| `-c, --config <path>` | 使用指定配置文件 |

---

### `crosscheck serve` [BETA]

常驻模式，监听固定端口，Webhook 只需手动注册一次。

```bash
crosscheck serve
```

| 参数 | 说明 |
|---|---|
| `-c, --config <path>` | 使用指定配置文件 |

---

### `crosscheck status`

显示认证状态、配置摘要和 CLI 版本信息。

```bash
crosscheck status
```

```
crosscheck status

  Auth
  ✓ codex                  authenticated
  ✓ claude                 2.1.x (Claude Code)
  ✓ GITHUB_TOKEN           via gh auth login
  ✓ WEBHOOK_SECRET         auto-managed at ~/.crosscheck/webhook-secret

  Config
    mode                   cross-vendor
    quality tier           balanced
    codex auth             subscription
    claude model           sonnet
    per-review budget      $2.00/review

  Impact
    summary                47 reviews · ~43h saved · 19 issues caught
                           (run crosscheck impact for details)

  Logs
    path                   ~/.crosscheck/logs/
    today                  2026-05-08.ndjson  (12 entries)

  CLIs
    codex                  codex-cli 0.128.0
    claude                 2.1.x (Claude Code)
```

| 参数 | 说明 |
|---|---|
| `-c, --config <path>` | 检查指定配置文件的状态 |

---

### `crosscheck diagnose`

读取 `~/.crosscheck/logs/`，找出失败模式、审查者表现和改进建议。

```bash
crosscheck diagnose
crosscheck diagnose --since 2026-05-01
crosscheck diagnose --json
```

```
crosscheck diagnose

  Period   2026-05-07 → 2026-05-08  (1 log file)

  Reviews
    total       6
    successful  3
    failed      3  (50% failure rate)

  Reviewer performance
    codex    1/4 success  25%
    claude   2/2 success  100%

  Verdict distribution
    APPROVE     2  (67%)
    NEEDS WORK  1  (33%)
    BLOCK       0  (0%)

  Error patterns
    ✗ command not found: tsc                    ×2  (codex)
    ✗ base branch missing: staging              ×2

  Languages detected
    typescript, nodejs

  Suggestions
    → tsc: command not found ×2 (codex)
      add to instructions.md: "Do not run tsc, ts-node, or tsx."
    → base branch 'staging' not found ×2 — verify branch is fetched before review

  Run `crosscheck optimize` to apply suggestions automatically.
```

| 参数 | 说明 |
|---|---|
| `--json` | 以 JSON 格式输出完整报告（用于脚本或传给 `optimize`） |
| `--since <YYYY-MM-DD>` | 只分析该日期之后的日志 |

---

### `crosscheck optimize`

内部运行 `diagnose`，选择最优 AI Agent，生成改进后的 `~/.crosscheck/instructions.md`。默认为预览模式（只显示 diff，不写入文件）。

```bash
crosscheck optimize             # 仅显示 diff
crosscheck optimize --apply     # 应用更改
crosscheck optimize --agent codex --apply
```

```
  Running diagnose...
  agent    claude  (default — both enabled, no data)

  diff  /Users/you/.crosscheck/instructions.md

  +## Constraints
  +
  +- Do not run tsc, ts-node, or tsx.
  +- Do not run npm, npx, yarn, or pnpm.
  ...

  Run with --apply to write changes to ~/.crosscheck/instructions.md
```

**`optimize` 使用哪个 Agent？**

`optimize` 根据你的配置和日志历史自动选择：

1. 只启用了一个供应商 → 使用该供应商。
2. 两个都启用 → 使用近期日志中成功率更高的那个。
3. 成功率相同或没有日志数据 → 默认使用 `claude`。
4. `--agent claude|codex` 覆盖以上所有逻辑。

| 参数 | 说明 |
|---|---|
| `--apply` | 写入改进后的 instructions（默认为预览模式） |
| `--dry-run` | 显示 diff 不写入（默认行为，显式别名） |
| `--agent <claude\|codex>` | 强制使用指定 Agent，忽略配置和日志数据 |
| `--since <YYYY-MM-DD>` | 限制作为输入的 diagnose 时间窗口 |
| `-c, --config <path>` | 配置文件路径 |

---

### `crosscheck impact`

报告审查历史带来的累计价值：节省的时间、发现的问题和代码质量趋势。读取 `~/.crosscheck/logs/`，无网络请求。

```bash
crosscheck impact
crosscheck impact --money
crosscheck impact --since 2026-01-01
crosscheck impact --json
```

```
crosscheck impact  (all time · 47 reviews)

  Time saved
  ──────────────────────────────────────────────
  Reviews run              47
  Avg AI review time       ~14 min
  Assumed human time       60 min  ⓘ
  Total time saved         ~43 h

  Issues caught
  ──────────────────────────────────────────────
  APPROVE              28   (60%)
  NEEDS WORK           14   (30%)  ← actionable feedback
  BLOCK                 5   (11%)  ← potential bugs / breaking changes
  Total issues caught  19

  Code quality trend  (BLOCK rate, weekly)
  ──────────────────────────────────────────────
  May W1    ████████████████  22%
  May W2    ████████████      17%
  May W3    ████████          11%   ↓ improving

  ⓘ assumes 60 min avg human review — set impact.assumed_human_review_minutes to adjust
  Run crosscheck impact --money for a rough monetary estimate.
```

| 参数 | 说明 |
|---|---|
| `--money` | 追加基于 `impact.hourly_rate_usd` 和 `impact.defect_cost_usd` 的货币估算 |
| `--since <YYYY-MM-DD>` | 只分析该日期之后的日志 |
| `--json` | 以 JSON 格式输出完整报告 |
| `-c, --config <path>` | 配置文件路径 |

货币估算公式：`(hours_saved × hourly_rate_usd) + (issues_caught × defect_cost_usd)`。默认值：`$150/hr`、`$150/issue`，均可在 `crosscheck.config.yml` 的 `impact` 节点中配置。

---

## 配置

crosscheck 按以下顺序查找配置文件（找到第一个为止）：

1. `~/.crosscheck/config.yml` ← **默认位置**
2. `./crosscheck.config.yml`
3. `./.crosscheck.yml`

运行 `crosscheck init` 生成注释完整的初始配置文件。

### 完整配置参考

```yaml
# ── 模式 ──────────────────────────────────────────────────────────────────────
# single-vendor: 由一个 AI 审查所有 PR
# cross-vendor:  Claude ↔ Codex 互相审查
mode: cross-vendor

# ── 供应商 ───────────────────────────────────────────────────────────────────
vendors:
  codex:
    enabled: true
    auth: subscription      # subscription | api-key
    model: o4-mini          # 仅在 auth: api-key 时生效

  claude:
    enabled: true
    model: sonnet           # haiku | sonnet | opus
    effort: medium          # low | medium | high | max

# ── 质量 ───────────────────────────────────────────────────────────────────
quality:
  tier: balanced            # fast | balanced | thorough
  focus:                    # 收窄审查范围（可选）
    - security
    - types
    - performance
  custom_prompt: |          # 追加到每次审查提示词末尾
    Be concise. Flag only issues that would block a merge.

# ── 预算 ────────────────────────────────────────────────────────────────────
budget:
  codex_monthly_usd: 20     # null = 不限；仅在 auth: api-key 时生效
  per_review_usd: 2.00      # 传给 claude --max-budget-usd

# ── Org — 一个 Webhook 覆盖 Org 下所有仓库 ─────────────────────────────────
# 同时设置时优先级高于 `repos`。
orgs:
  - motivation-labs
  - codatta

# ── Repo — 仅监控指定仓库 ────────────────────────────────────────────────────
# 使用 `orgs` 时可省略。watch 模式下，若为空则自动从 git remote 检测。
repos:
  - owner: acme
    name: specific-repo

# ── 路由 ───────────────────────────────────────────────────────────────────
routing:
  codex_reviews_patterns:
    - "Generated with \\[Claude Code\\]"
  claude_reviews_patterns:
    - "Generated with \\[OpenAI Codex\\]"
    - "Co-Authored-By: codex"

  # 将审查限制为这些 GitHub 账号提交的 PR。
  # 由 `crosscheck init` 或首次运行 `crosscheck watch` 时自动从 gh auth 检测并填入。
  # 为空 = 不限制（所有匹配的 PR 都会被审查）。
  allowed_authors:
    - your-github-login  # 从 gh auth 自动检测

# ── 隧道（仅 watch 模式）──────────────────────────────────────────────────
# localhost.run（默认）—— SSH 隧道，零安装，URL 重连后会变化。
# smee —— 通过 smee.io 中继，稳定可靠；离线时事件排队等待。
#   设置：npm install -g smee-client，访问 https://smee.io/new
tunnel:
  backend: localhost.run
  # backend: smee
  # smee_channel: https://smee.io/your-channel-id

# ── Impact 报告 ──────────────────────────────────────────────────────────────
# 由 `crosscheck impact` 使用，计算预计节省的时间和货币价值。
impact:
  assumed_human_review_minutes: 60   # 节省时间计算的基准
  hourly_rate_usd: 150               # 用于 --money 估算
  defect_cost_usd: 150               # 每个发现的问题，用于 --money 估算

# ── 服务器 ────────────────────────────────────────────────────────────────────
server:
  port: 7891
  webhook_path: /webhook
```

### 质量层级

| 层级 | 速度 | 深度 | 适合场景 |
|---|---|---|---|
| `fast` | ~10s | 仅核心问题 | 高频仓库、草稿 PR |
| `balanced` | ~30s | 完整审查，解释所有问题 | 大多数团队的默认选择 |
| `thorough` | ~60–90s | 深度多轮，架构 + 安全 | 合并到 main 之前 |

### 路由模式

模式对 PR 正文进行大小写不敏感的正则表达式匹配。

- `codex_reviews_patterns` — 匹配这些模式的 PR 由 Codex 审查
- `claude_reviews_patterns` — 匹配这些模式的 PR 由 Claude 审查

如需同时审查人工提交的 PR，添加通配符：

```yaml
routing:
  codex_reviews_patterns:
    - "Generated with \\[Claude Code\\]"
    - ".*"    # Codex 审查所有 PR
```

### 最简配置

```yaml
mode: cross-vendor
```

其他所有选项使用默认值。

---

## 工作原理

```
GitHub 仓库
    │  pull_request 事件（opened / synchronize）
    ▼
crosscheck webhook 服务器
    │
    ├─ 验证 HMAC-SHA256 签名
    ├─ 从 PR 正文模式检测来源
    ├─ 分配审查者（cross-vendor 模式下为对立供应商）
    │
    ▼
将 PR 分支克隆到临时目录
    │
    ├─ codex review --base <branch>       ← 非交互式 Codex 审查
    │  或
    └─ claude --print --bare ...          ← 非交互式 Claude 审查
            │
            ▼
    通过 GitHub API 在 PR 中发布评论
    删除临时克隆
```

### PR 来源检测

| 默认模式 | 匹配对象 |
|---|---|
| `Generated with \[Claude Code\]` | Claude Code 提交的 PR |
| `Generated with \[OpenAI Codex\]` | Codex CLI 提交的 PR |
| `Co-Authored-By: codex` | Codex 联合提交的 commit |

### 审查者分配

| 模式 | PR 来源 | 审查者 |
|---|---|---|
| `cross-vendor` | claude | Codex |
| `cross-vendor` | codex | Claude |
| `cross-vendor` | 人工 | 无 — 跳过 |
| `single-vendor` | 任意 | 第一个启用的供应商 |

### Codex 审查如何运行

```bash
codex review --base <base-branch> --title "<pr-title>"
```

`--base` 标志将当前 HEAD 与基础分支进行差异比较——与 PR diff 完全一致。使用 `auth: subscription` 时不传入模型参数。使用 `auth: api-key` 时，模型由质量层级决定（`fast` → `gpt-4o-mini`，`balanced` → `o4-mini`，`thorough` → `o3`）。

### Claude 审查如何运行

```bash
claude \
  --print --bare \
  --model claude-sonnet-4-6 \
  --effort medium \
  --max-budget-usd 2.00 \
  --output-last-message /tmp/review.md \
  --allowedTools "Bash(git diff),Bash(git log)" \
  "<prompt>"
```

`--bare` 使执行快速且确定性。`--allowedTools` 将 Claude 限制为只能在克隆的仓库上执行只读的 git 操作。

### 去重

GitHub 可能对同一次推送同时触发 `opened` 和 `synchronize` 事件。crosscheck 在内存中追踪 `owner/repo#pr@sha`，丢弃同一 commit 的重复事件。

### Watch vs Serve

| | `watch` | `serve` [BETA] |
|---|---|---|
| 隧道 | `localhost.run`（SSH，无需安装） | 无 — 直连端口 |
| Webhook | 自动管理，退出时清理 | 手动，永久有效 |
| 覆盖范围 | Org 级或 Repo 级 | Org 级或 Repo 级 |
| 目标机器 | 开发者笔记本 | mac-mini / 服务器 |
| 生命周期 | 与终端绑定 | Daemon / 服务 |

### 安全性

- **Webhook 签名** — 每个请求在解析前用 HMAC-SHA256 验证
- **临时隔离** — 每个 PR 克隆到独立临时目录，审查后删除
- **只读工具** — Claude 仅限使用 `git diff` 和 `git log`
- **不在克隆中存储凭证** — `gh repo clone` 使用 gh credential helper，不将 Token 写入磁盘

---

## 常见问题

### crosscheck 如何随时间自我改进？

每次审查（成功或失败）都会追加到 `~/.crosscheck/logs/YYYY-MM-DD.ndjson`。运行 `crosscheck diagnose` 读取这些日志，找出规律：哪些命令失败了，哪个审查者表现不佳，哪些语言特定工具缺失。运行 `crosscheck optimize` 将该报告输入给表现最好的 AI Agent（由内置 `AGENT.md` 指导），生成改进后的 `~/.crosscheck/instructions.md`。两个审查者（claude 和 codex）在每次审查前都会读取 `instructions.md`，因此改进在下一个 PR 即时生效。

### `crosscheck optimize` 使用哪个 Agent？

自动选择：
1. 配置中只启用了一个供应商 → 使用该供应商。
2. 两个都启用 → 使用近期日志中成功率更高的那个。
3. 成功率相同或没有数据 → 默认使用 `claude`。
4. 随时可以覆盖：`crosscheck optimize --agent codex`。

`optimize` 使用的 Agent 与审查你的 PR 的 Agent 相互独立——`optimize` 的目的是改进指令，而不是审查代码。

### `~/.crosscheck/instructions.md` 是什么，可以编辑吗？

可以——这是一个普通的 Markdown 文件，`codex` 和 `claude` 在每次审查前都会读取。首次使用时，crosscheck 会用安全的默认内容初始化它（无构建工具限制、聚焦的审查提示词和 VERDICT 格式）。你可以随时手动编辑。`crosscheck optimize --apply` 会覆盖写入，如果你有自定义编辑想保留，请提前备份或纳入版本控制。

重置为默认值：
```bash
rm ~/.crosscheck/instructions.md
```
下一次审查会重新用内置默认值初始化。

### 可以设置项目级指令吗？

可以。在仓库根目录创建 `.crosscheck/instructions.md`。crosscheck 优先查找项目级文件，如果存在则使用它，而不是用户级文件。这样你可以在不影响其他仓库的情况下，为每个项目设置专属约束（例如"这是一个 Rust 项目——不要建议 TypeScript 模式"）。

### `AGENT.md` 是什么？

`AGENT.md` 是指导 AI 在 `crosscheck optimize` 期间工作的框架文档，定义了输入/输出约定、语言检测规则、约束编写指南和质量原则。随 crosscheck 捆绑提供，使 `optimize` 开箱即用。

你可以在项目根目录或 `.crosscheck/AGENT.md` 放置本地覆盖文件。crosscheck 优先查找本地覆盖，然后回退到内置版本。这允许团队针对自己的技术栈或规范自定义优化逻辑。

### 为什么审查失败，提示 "command not found"？

审查者（codex 或 claude）尝试运行一个在临时克隆中不存在的 CLI 工具（例如 `tsc`、`pytest`）。克隆是浅层 `git` checkout，没有 `node_modules` 或其他已安装的依赖。运行 `crosscheck diagnose` 查看哪些命令失败了，然后运行 `crosscheck optimize --apply` 在 `instructions.md` 中添加相应约束，让审查者停止尝试这些命令。

### 为什么审查失败，提示 "no such branch"？

crosscheck 在临时克隆中获取 PR 基础分支（例如 `staging`）后再运行审查者。如果获取失败（网络问题、分支已删除、Token 权限不足），审查者无法正确进行差异比较。检查：
- 基础分支存在且可以用你的 Token 访问。
- `GITHUB_TOKEN` 拥有 `repo` 权限。
- PR 中的分支名与远程一致。

### 如何用 smee.io 代替 localhost.run？

`localhost.run`（默认）在你的笔记本离线时 GitHub 触发 Webhook 的事件会丢失。[smee.io](https://smee.io) 会将事件排队，等笔记本重新联网后重放——适合审查机器不总是在线的情况。

```bash
npm install -g smee-client
```

访问 [smee.io/new](https://smee.io/new) 并复制 Channel URL。然后在 `crosscheck.config.yml` 中：

```yaml
tunnel:
  backend: smee
  smee_channel: https://smee.io/your-channel-id
```

将 smee Channel URL 注册为 GitHub Webhook 的 Payload URL 一次即可。crosscheck 会自动将事件从 Channel 转发到本地服务器。与 `localhost.run` 不同，重启后无需重新注册。

### optimize 会自动运行吗？

不会——`crosscheck optimize` 始终由用户手动触发。你在需要改进指令时才运行它，没有后台守护进程或定时任务。未来版本可能会增加可选的 `--schedule` 模式，但默认值将始终是手动触发，以保持你对 `instructions.md` 写入内容的掌控。
