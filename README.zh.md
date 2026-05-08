<div align="right">
  <h5><a href="./README.md">🌐 &nbsp;English</a></h5>
</div>

<p align="center">
  <img src="./assets/logo.png" alt="crosscheck" width="160" />
</p>

# crosscheck

**一个轻量级编排层，让你的 AI 编程助手互相审查代码——并自动修复问题。**

当 Claude Code 提交 PR 时，由 Codex 审查；当 Codex 提交 PR 时，由 Claude 审查。发现问题后，原作者 Agent 提交修复并推送回去。这一切都在你的本地机器上运行，使用你已有的订阅，一条命令即可启动。

```
GitHub PR  →  crosscheck watch  →  AI 审查意见发布  →  修复提交
```

> 灵感来自 [Symphony](https://github.com/openai/symphony) —— OpenAI 的规范驱动多智能体框架。Symphony 在产品/交付层面协调 Agent，而 crosscheck 保持在工程师最熟悉的工作层面：Pull Request、代码差异和 Code Review。无需引入新的抽象概念——只是将 CR + 修复的工作流程自动化。

---

## 为什么选择 crosscheck

AI 编程助手提交代码的速度很快，但也会自信地犯下看似合理的错误。解决方案不是让人类审查每一个 AI 提交的 PR——而是让*另一个* AI 来审查。Claude 和 Codex 有互补的盲点，跨供应商审查比任何单一模型都能发现更多问题，同时不会给每次提交增加人工审查的延迟。

crosscheck 将这个闭环连接起来：

| | |
|---|---|
| **本地执行，持续监听** | 在你的机器上运行。`crosscheck watch` 打开隧道后持续运行，无需云服务、基础设施或 SaaS。 |
| **订阅驱动，无额外计费** | 调用 `claude` 和 `codex` 命令行工具，使用你已有的 Claude Pro/Max 和 ChatGPT Plus/Pro 订阅。无需按 token 付费，订阅后审查完全免费。 |
| **默认跨供应商** | Claude 审查 Codex 的 PR；Codex 审查 Claude 的 PR。每个模型有不同的训练数据和不同的故障模式，交叉点正是 Bug 藏身之处。 |
| **持续自我优化** | `crosscheck diagnose` 从日志中发现失败模式，`crosscheck optimize` 将这些模式反馈给 AI，自动更新审查指令。 |

---

## 快速开始

```bash
# 1. 安装 crosscheck 及 Agent CLI
npm install -g @motivation-labs/crosscheck
npm install -g @anthropic-ai/claude-code && claude        # 需要 Claude Pro/Max 订阅
npm install -g @openai/codex && codex login --device-auth # 需要 ChatGPT Plus/Pro 订阅
brew install gh && gh auth login                          # GitHub CLI

# 2. 检查运行环境
crosscheck init

# 3. 对单个 PR 进行测试
crosscheck review https://github.com/your-org/repo/pull/42

# 4. 持续运行
crosscheck watch
```

`crosscheck watch` 会通过 `localhost.run` 建立 SSH 隧道（无需安装任何软件，无需账号），自动注册 GitHub Webhook，然后开始监听。GitHub 推送 PR 事件后，crosscheck 将其路由到正确的审查者。

---

## 工作原理

```
┌────────────────────────────────────────────────────────────────┐
│  你的笔记本                                                      │
│                                                                 │
│  crosscheck watch                                               │
│    ├── SSH 隧道 (localhost.run)  ◄──── GitHub Webhook           │
│    ├── Webhook 服务器 (:7891)                                    │
│    └── PR 处理器                                                 │
│         ├── 识别来源  (Claude Code? Codex? 其他?)                │
│         ├── 克隆 PR 分支                                         │
│         ├── 运行审查者  (跨供应商分配)                            │
│         ├── 发布审查评论                                          │
│         └── 地址步骤  (修复问题，推送 [crosscheck] 提交)          │
└────────────────────────────────────────────────────────────────┘
```

**路由** 基于 PR 正文的匹配模式。`Generated with [Claude Code]` → 由 Codex 审查；`Generated with [OpenAI Codex]` → 由 Claude 审查。`allowed_authors` 字段将审查限制在你的 Agent 账号提交的 PR 上。

**地址步骤**（可选，通过工作流配置启用）在审查完成后运行。原作者 Agent 读取自己的审查评论并将修复提交回 PR 分支，提交前缀为 `[crosscheck]`，每个 PR 最多提交 5 次修复。

**反馈闭环** 通过 `crosscheck diagnose` → `crosscheck optimize` 实现。`~/.crosscheck/logs/` 中的失败模式和质量信号会自动反馈为更好的审查指令，无需手动编辑配置。

---

## watch 运行输出示例

```
$ crosscheck watch

  "Move fast and review things."

crosscheck watch

  repos     your-org/your-repo
  mode      cross-vendor
  quality   balanced
  config    ./crosscheck.config.yml  ← 编辑此文件可修改配置

  ✓ 隧道已就绪: https://abc123.lhr.life
  ✓ 已为 your-org/your-repo 注册 Webhook
等待 PR 事件 — 按 Ctrl+C 停止。

PR #47 opened: add retry logic for flaky network calls
  origin=claude  reviewer=codex
  codex reviewing... (12s)
  review complete (12s)
  posted → github.com/your-org/your-repo/pull/47
  NEEDS WORK

PR #48 opened: implement caching layer
  origin=codex  reviewer=claude
  claude reviewing... (18s)
  review complete (18s)
  posted → github.com/your-org/your-repo/pull/48
  APPROVE
```

---

## 命令列表

```bash
crosscheck init                     # 检查环境，生成初始配置文件
crosscheck review <pr-url>          # 对指定 PR 进行一次性审查
crosscheck watch                    # 本地开发模式——隧道 + 自动 Webhook + 监听
crosscheck serve                    # 常驻模式——固定端口，手动注册 Webhook
crosscheck status                   # 查看认证状态、配置、日志摘要、CLI 版本
crosscheck diagnose                 # 从审查日志中提取失败模式
crosscheck optimize [--apply]       # 根据 diagnose 输出更新审查指令
crosscheck impact [--money]         # 节省时间、发现问题、代码质量趋势报告
```

---

## 配置说明

`crosscheck.config.yml` 位于项目根目录，AI 编程助手可以直接读取和修改它。

```yaml
# 监听的组织/仓库（至少配置一项）
orgs:
  - your-org                      # 覆盖该组织下的所有仓库

# 仅审查这些 GitHub 账号提交的 PR
routing:
  allowed_authors:
    - your-claude-bot-account
    - your-codex-bot-account

# 审查深度
quality:
  tier: balanced                  # fast（快速）| balanced（均衡）| thorough（深度）

# 可选费用上限
budget:
  per_review_usd: 2.0
  codex_monthly_usd: 50

# 隧道后端（仅 watch 模式使用）
# localhost.run — 无需安装，自动重连（默认）
# smee         — 稳定的频道 URL，离线时事件排队
tunnel:
  backend: localhost.run
```

完整配置参考：[get-started.zh.md](./get-started.zh.md)

---

## 持续自我优化

每次审查结果都会记录到 `~/.crosscheck/logs/YYYY-MM-DD.ndjson`。随着时间推移，规律会逐渐显现——审查者尝试运行（并失败）的命令、判断分布、审查时长趋势。

```bash
# 查看问题所在
$ crosscheck diagnose

crosscheck diagnose  (2026-01-01 → 2026-05-08 · 3 个日志文件)

  审查总计   47 次  —  28 APPROVE  14 NEEDS WORK  5 BLOCK
  失败率     codex 12%  /  claude 4%

  建议
  ─────────────────────────────────────────────────────────────
  ✦ codex 在审查时尝试运行 `npm test`（7 次）
    → 在 instructions 中添加："不要运行 npm、tsc 或测试命令。"
  ✦ 3 次审查在大型 PR（>400 行改动）上超时
    → 考虑为超过一定大小的 PR 设置 quality.tier: fast

# 自动应用修复建议
$ crosscheck optimize --apply
  agent  claude（失败率更低：4% vs codex 12%）
  正在写入 ~/.crosscheck/instructions.md
  + 不要运行 npm、tsc、jest 或任何构建/测试命令。
  + 将超过 400 行改动的 PR 标记为过大，无法进行深度审查。
  完成

# 量化累计价值
$ crosscheck impact --money

crosscheck impact  (全部时间 · 47 次审查)

  节省时间
  ──────────────────────────────────────────────
  审查次数             47
  AI 平均审查时间      ~14 分钟
  人工预估时间         60 分钟  ⓘ
  共节省时间           ~43 小时

  发现问题
  ──────────────────────────────────────────────
  APPROVE              28   (60%)
  NEEDS WORK           14   (30%)  ← 可操作的反馈
  BLOCK                 5   (11%)  ← 潜在 Bug / 破坏性变更
  共发现问题           19

  估算价值: ~$8,450
  (43h × $150/hr + 19 个问题 × $150/个)
```

---

## 部署方式

### 笔记本 — `crosscheck watch`

零配置。通过 `localhost.run` 建立 SSH 隧道处理 NAT 穿透，无需端口转发，无需云账号。如果隧道静默断开，健康检查会在约 2 分钟内检测到并强制重连 + 重新注册 Webhook。

```bash
crosscheck watch
# → 打开隧道，注册 Webhook，开始监听
```

### 服务器 — `crosscheck serve`

绑定到具有公网 IP 的机器上的固定端口，手动注册一次 Webhook 即可。

```bash
crosscheck serve
# → 监听 :7891，手动注册 https://your-server/webhook
```

### smee.io — 稳定中继（可选）

当笔记本离线时，`localhost.run` 会丢失事件。[smee.io](https://smee.io) 会将事件排队，在重新连接后回放——适合审查机器不总是在线的团队。

```bash
npm install -g smee-client
# 访问 https://smee.io/new — 复制频道 URL
```

```yaml
# crosscheck.config.yml
tunnel:
  backend: smee
  smee_channel: https://smee.io/your-channel-id
```

---

## 系统要求

| | 最低版本 |
|---|---|
| Node.js | 18+ |
| Claude Code CLI | 最新版 — `npm install -g @anthropic-ai/claude-code` |
| Codex CLI | 最新版 — `npm install -g @openai/codex` |
| GitHub CLI | 2.65+ — `brew install gh` |

运行 `gh auth login` 后，`GITHUB_TOKEN` 会自动获取，无需手动导出。

---

## 文档

| | |
|---|---|
| **[get-started.zh.md](./get-started.zh.md)** | 完整安装指南——前置条件、所有命令与参数、完整配置参考、工作原理、常见问题 |
| **[crosscheck.config.example.yml](./crosscheck.config.example.yml)** | 带注释的配置文件示例（每个选项均有说明） |
| **[AGENT.md](./AGENT.md)** | `crosscheck optimize` 使用的 Harness 文档——AI 如何优化审查指令 |

---

## 参与贡献

欢迎提交 Issue 和 PR：[github.com/Motivation-Labs/crosscheck](https://github.com/Motivation-Labs/crosscheck)

---

## 许可证

[MIT](./LICENSE) — Copyright (c) 2025–2026 Motivation Labs LLC.
