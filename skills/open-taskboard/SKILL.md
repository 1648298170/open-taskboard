---
name: open-taskboard
description: 管理 opencode Taskboard 的任务：查看、拆解、领取、跟踪任务状态。Use when the user asks to 看任务/拆解任务/拆分需求/更新任务状态/领取任务, or when starting work that should be tracked on the taskboard.
---

# Taskboard 管理

> 完整接入与工作流手册（连接方式 / 唤醒协议 / 错误处理）：[docs/AI-INTEGRATION.md](../../docs/AI-INTEGRATION.md)。

本地任务板有两种等价的操作方式，按优先级选择：

1. **MCP 工具**（若已配置 `taskboard` MCP server）：`list_issues` / `show_issue` / `create_issue` / `update_issue` / `add_comment` / `progress`。工作流规则相同：`update_issue` 必须携带 `show_issue` 返回的 `version`（乐观锁）。
2. **`taskboard` CLI**：服务地址默认 `http://127.0.0.1:47824`（环境变量 `TASKBOARD_URL` 可覆盖；服务未运行时先 `taskboard serve` 后台启动）。

## 核心工作流

处理任何任务时严格遵循以下状态流转：

```
todo → in_progress → in_review → done
```

- **不流转不许开工**（dashi 语义）：服务端 `claim` 会把 `todo` 自动置为 `in_progress`（认领即开工）——开工必须先 claim，不存在"干着活但状态还在 todo"的合法状态。认领冲突（409）重读一次，条件不变才重试，绝不抢他人的认领。
- **会话绑定**：agent 创建任务带自己的 sessionId；认领未绑定任务时传 `claim_issue sessionId` / `claim --session-id`（认领即绑定，只绑空位）；已绑他人会话不抢绑——绑定即所有权，接管需显式解绑。
- **done 只能由用户确认后设置**。完成工作并验证后，把任务置为 `in_review`，向用户报告，等用户明确认可（或明确要求标记完成）才置 `done`。
- **收尾必推唤醒评论（硬性规则）**：TUI 注入通道下 watch 观测不到你何时干完（人工回车提交，headless 的 exit-0 自动标只属于 spawn 通道）；被 `@agent` 唤醒并处理完后，把该唤醒评论置 `processed`（`comment edit <commentId> --status processed` / MCP `update_comment`）——不落此步评论永远停在「唤醒中」，面板无法知道指令已被消化。
- 每次修改任务用乐观锁：先 `issue show` 读取 `version`，更新时带上 `--expected-version N`。版本冲突说明别人改过，重新读取再操作。

## 常用命令

```bash
# 项目
taskboard project list
taskboard project create --id my-project --name "My project" --workspace-path /abs/path

# 查看任务
taskboard issue list --project my-project
taskboard issue show <issue-id>

# 创建任务 / 拆解子任务（--parent 挂到父任务下，仅支持两层）
taskboard issue create --project my-project --title "实现 X" \
  --priority high --branch feat/x --description "需求细节"
taskboard issue create --project my-project --parent <父任务ID> --title "子步骤"

# 状态流转
taskboard issue update <id> --status in_progress --expected-version <v>
taskboard issue update <id> --status in_review --expected-version <v>
taskboard issue done <id> --expected-version <v>

# 记录进展
taskboard comment add <id> --author opencode --body "完成了 X，剩余 Y"

# 整体进度
taskboard progress --project my-project
```

## 拆解任务的规则

1. 用户的初始需求若包含多个子需求，先创建一个**父任务**（顶层），再为每个可独立交付的子需求创建**子任务**（`--parent`），不要把多个需求塞进一个任务。
2. 子任务标题用动词开头、可验证的粒度（一次会话能完成）。
3. 每个子任务尽量绑定分支（`--branch`）。
4. 拆解后向用户展示任务清单（`issue list`）确认。
5. 子任务开工（认领或手动流转）会自动把 `todo` 父任务拉到 `in_progress`（单向）；父任务的 `in_review`/`done` 始终人工——全子 done 也不自动关闭父任务。

## 跟踪任务的规则

1. 开始做某个任务前：`issue claim <id> --agent <名字>`（todo 任务认领即自动流转 `in_progress`；手动 `issue update --status in_progress` 等价）。认领未绑定任务时带 `--session-id` 绑定自己的 opencode 会话。
2. 遇到阻塞或重要结论：写 `comment add`，而不是只留在对话里。
3. 完成并自验后：任务 `--status in_review` + 评论写明验证方式，并把本次唤醒你的待处理评论置 `processed`（见上「收尾必推唤醒评论」），请用户验收。
4. 用户确认后才 `issue done`。
5. 顶层父任务在所有子任务 done 后才算完成，不要提前关闭父任务。
