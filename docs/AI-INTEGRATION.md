# AI 接入手册（AI-INTEGRATION）

> 本文档写给**要接入 open-taskboard 的 AI agent**（以及配置 AI 的人类）。
> 目标：AI 读完本文即可正确地读写任务板，不需要再问任何问题。
> 人类用户请看 [README.md](../README.md)。

open-taskboard 是一个本地优先的任务看板：人类在 Web 面板上拆任务、验收任务；AI（你）通过工具读写任务、执行任务。双方共享同一块板。

---

## 1. 连接（三种方式，任选其一）

### 方式 A：MCP（推荐）

在 AI 工具的配置里加一个 MCP server（无状态进程，自动连接/拉起本地服务）：

```json
{ "mcpServers": { "taskboard": { "command": ["node", "/绝对路径/open-taskboard/apps/mcp/dist/mcp.js"] } } }
```

Claude Code 用 `.mcp.json`（`command` 为字符串数组外的对象形式），Codex 用 TOML，opencode 用 JSON——形态见 README「接入 agent 工具」。

接入后你会得到这些工具：`list_projects` `create_project` `update_project` `delete_project` `list_issues` `show_issue` `create_issue` `update_issue` `delete_issue` `archive_issue` `unarchive_issue` `claim_issue` `heartbeat_issue` `release_issue` `add_comment` `update_comment` `delete_comment` `add_issue_dependency` `remove_issue_dependency` `list_attachments` `upload_attachment` `progress` `project_stats` `ready_issues` `next_issue` `search_issues` `export_board`。

### 方式 B：CLI

```bash
taskboard issue list --project my-project     # 列任务
taskboard issue show <id>                     # 详情（含评论/活动/子任务）
taskboard next --project my-project           # 智能取下一个该做的任务
```

### 方式 C：REST

服务启动后的机器可读契约：`GET /api/openapi.json`（OpenAPI 3.1，包含全部端点与 schema）。写操作需带 `x-taskboard-actor` 头标识自己（如 `codex`、`claude`）；服务设置了 `TASKBOARD_TOKEN` 时带 `Authorization: Bearer <token>`。

---

## 2. 核心工作流（5 步）

```
①取任务 → ②认领 → ③开工执行 → ④交验 → ⑤等人类确认
```

| 步骤 | 动作 | 说明 |
|---|---|---|
| ① 取任务 | `next_issue` / `ready_issues` | 自动跳过他人租约中的任务，只返回依赖已满足的 |
| ② 认领 | `claim_issue {agent: "你的名字", sessionId: "你的会话id"}` | **认领即开工**：服务端自动把 `todo` 流转为 `in_progress`，并把任务绑定到你的会话（仅当未绑定时；已绑他人会话不抢绑） |
| ③ 执行 | 干活 + `add_comment` 记录进展 | 重要结论写评论，不要只留在对话里 |
| ④ 交验 | `update_issue {status: "in_review"}` + 评论写明验证方式 | 然后停下来，向人类报告 |
| ⑤ 等确认 | 人类在面板点 done，或明确说"确认"后你传 `confirm: true` | **默认配置下 agent 直接置 done 会被 403 拒绝** |

**创建任务时的会话解析顺序**：请求体 `sessionId` → `x-taskboard-session` 头（agent 当前会话）→ 项目默认会话（`project.sessionId`）→ 未绑定。省略会话时自动继承项目默认；修改项目默认会话只影响后续新建任务，已有任务不会追溯改绑。

**声明并保持会话**：CLI 用 `--session-id <id>` 或环境变量 `TASKBOARD_SESSION_ID`（每次请求自动带 `x-taskboard-session`，`--session-id` 优先）；MCP 会记住你最近一次声明的 `sessionId` 并自动随请求发送该头，`create_issue` 未显式传时省略字段，从而继承项目默认。整个工作流尽量使用同一个会话 ID，人类才能唤醒并延续你的上下文。

## 3. 硬规则（违反 = 破坏协作）

| 规则 | 内容 | 违反后果 |
|---|---|---|
| 不流转不许开工 | 开工前必须 `claim`（服务端自动流转 in_progress） | 看板失真；他人不知道你在干 |
| 已绑他人会话不抢绑 | 任务 `sessionId` 是所有权凭证；认领不改变已有绑定 | 劫持他人的唤醒通道 |
| 开工必绑（403 硬门禁） | claim/PATCH 流转 in_progress 必须带 `sessionId`+`branch`；被 403 拦了就按错误文案补齐重试 | 跳过绑定直接开工 |
| 不可编辑 agent 评论 | 评论编辑权只属于创建它的网页用户；agent 评论永远原样（你也不可编辑自己的历史评论） | 事后篡改 agent 发言 |
| 乐观锁 | 所有变更带 `show_issue` 返回的 `version` | 409 = 别人改过，重读再改一次，仍失败就停下报告，**绝不循环重试** |
| 认领冲突 | 409 = 他人持有有效租约 | 重读一次，条件不变才重试，否则放弃；**绝不抢他人的认领** |
| done 需人类确认 | `in_review` 后停下等验收（`TASKBOARD_HUMAN_DONE` 默认开启） | 403；人类明确说"确认"后才可传 `confirm: true` |
| 父任务人工关闭 | 子任务开工自动拉起 `todo` 父任务 → `in_progress`（单向）；父任务 `in_review`/`done` 永远人工，全子 done 也不自动关父 | 不要代替人类关闭父任务 |
| 附件限额 | 每任务 ≤20 个、总量 ≤50MB | 超限 400，消息带当前用量 |
| 绑定你的会话 | 创建任务优先带自己的 `sessionId`，省略时继承项目默认会话；认领未绑定任务时传 `claim_issue sessionId` | 人类才能通过面板唤醒"延续你上下文"的会话 |

## 4. 被人类唤醒（watch 侧车）

面板上 `@agent` 开头的评论会触发 watch 侧车（需已部署，见 README「评论唤醒 agent」）：

- watch 把指令送达 agent 的 TUI 输入框（opencode 专属，人工回车确认）或拉起 headless 会话（任意 agent CLI：`--exec "claude -p"` / `codex exec` / `cursor-agent -p` / 默认 `opencode run`）；你会被醒到哪条通道由部署者决定
- 你收到的唤醒 prompt 形如：`#<任务ID> <任务标题>\n[看板唤醒] …\n收尾：处理完把本次唤醒评论置为 processed…\n指令：<评论指令>`
- 正确反应：读任务详情（`show_issue` + `comment list`）→ 按上面 5 步工作流执行
- **别在回执评论里用 `@agent` 开头**：默认不做 actor 过滤，你自己写的唤醒评论会把你自己再叫醒（形成循环）。部署方用 `watch --ignore-author <你的actor>` 把你加入忽略名单后才会免疫（`watch` 这个 actor 始终被忽略）；不带该参数的部署下，回执评论请用别的前缀
- 多终端部署（README「评论唤醒 agent」）：watch 按项目数据里的 `wake_channel` 绑定路由（面板建项目只需选会话，服务地址由服务端解析并写入新项目 `wakeChannel`；CLI 可显式绑 `--wake-port` 与会话）——你只会收到管道通到你端口的项目 `@agent` 评论；同一 serve 端口被多终端 attach 时注入是广播，只入库一次信息即可，不要重复认领
- 唤醒评论有状态机（`pending`→`processing`→`processed`）：watch 唤走即置 processing，headless 跑完自动 processed；人类编辑保存 pending 评论会再次唤醒你（评论内容可能已更新——处理前先 `show_issue` 重读最新指令）；重唤会顺带重开停在 `in_review`/`done` 的任务为 `in_progress`（新建与编辑路径同一契约）；TUI 注入通道 watch 观测不到你的完工时机——**收尾时把你正在处理的唤醒评论置 `processed`**（MCP 工具状态改为已处理 / CLI `comment edit <id> --status processed`），留一步评论会永远停在「唤醒中」；不要用 `update_comment` 改别人挂的唤醒指令状态，那是人工验收的权力
- 路由机制备忘：Web 新建任务需选择会话（项目有默认会话时自动预选，无默认会话的旧项目手动选择）；未显式指定时任务继承项目默认 `sessionId`。绑定会话优先使用 OpenCode v1 `POST /session/:id/prompt_async` 续原上下文；失败不降级到另一个会话，评论保留 pending 供重试。只有未绑定任务才按项目 `wake_channel` → `--tui-url` → headless 路由。修改项目会话只影响后续新建任务，已有任务不追溯改绑；watch 单实例即可覆盖多项目，改路由 = `project set --wake-port/--session-id` 改绑即时生效，不用重启 watch
- 部署平台：macOS / Windows / Linux 全兼容（Node ≥22.5 即可，零原生依赖）；常驻方案按平台选——mac/linux 后台进程或 launchd/systemd，Windows 用 pm2（`pm2 start … && pm2 save && pm2 startup`）或 NSSM，见 README「常驻方案对照」表

## 5. 状态机

```
todo → in_progress → in_review → done
```

- `todo`：待办。认领后自动变 `in_progress`，无需手动改
- `in_progress`：进行中（有租约/有人负责）
- `in_review`：自验完成，等人类验收
- `done`：人类确认通过
- 归档（`archive`）是独立维度：从看板隐藏但保留数据，可取消归档

## 6. 常见错误与正确反应

| 错误 | 含义 | 正确反应 |
|---|---|---|
| 409 `version conflict` | 乐观锁冲突，别人先改了 | `show_issue` 重读，合并意图后重试**一次**；仍冲突则停下报告 |
| 409 `issue claimed by ...` | 他人持有租约 | 换任务，或等租约过期（默认 30 分钟）；**绝不抢** |
| 403 `done requires human confirmation` | done 门禁开启 | 停在 `in_review`，等人类确认；人类确认后传 `confirm: true` |
| 403 `TASKBOARD_READONLY` | 看板只读模式 | 只读，不写 |
| 400 `attachment quota exceeded` | 附件超限 | 清理旧附件或减小文件 |
| `unknown tool` / 连接失败 | MCP/服务未就绪 | 检查服务是否运行（`taskboard serve` 或 Docker）；`TASKBOARD_NO_AUTOSTART=1` 时不会自动拉起 |

## 7. 拆解需求（父/子任务）

1. 人类需求含多个子需求时：先建**父任务**（顶层），再为每个可独立交付的子需求建**子任务**（`parentId`，仅支持两层）
2. 创建任务优先带自己的 `sessionId`（CLI `--session-id` / `TASKBOARD_SESSION_ID`，MCP 记住最近声明的会话）；省略时继承项目默认会话
3. 子任务标题动词开头、一次会话能完成
4. 拆完展示清单给人类确认

完整命令语法见 CLI `taskboard --help`，REST 契约见 `/api/openapi.json`。
