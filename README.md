# open-taskboard

本地优先（local-first）的任务看板，为 [opencode](https://opencode.ai) 及任何 agent 工具设计——看任务、拆解任务、跟踪任务。灵感来自 [dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard)（Codex 版），无需 CDP 注入。

**v0.3 起采用 pnpm monorepo：** `packages/core`（领域层，类型三端共享）+ `server`（Fastify）+ `cli` + `mcp` + `apps/web`（Vite + React）。SQLite 用 Node 22.5+ 内置 `node:sqlite`，无原生编译依赖。

## 架构

```
apps/
├── server/   @taskboard/server Fastify：REST + SSE + 静态托管看板（可部署应用）
├── web/      @taskboard/web    Vite + React 看板（可部署应用）
├── cli/      @taskboard/cli    taskboard 命令行（bin: taskboard，依赖 server 的 startServer）
└── mcp/      @taskboard/mcp    MCP server（bin: taskboard-mcp）
packages/
└── core/     @taskboard/core   类型 + Store（node:sqlite），server/cli/mcp/web 共享
skills/       opencode skill（工作流纪律）
```

划分约定与 Nx 等一致：`apps/` = 可部署应用（server、web、cli、mcp 四个入口），`packages/` = 共享库（core）。

```
Web 看板 ─┐
CLI      ─┼─→ Fastify 服务（node:sqlite + SSE，唯一权威）
MCP server ─┘   ↑ 各 agent 工具各自拉起一个 MCP 进程连这里
```

## 快速开始

```bash
pnpm install      # 需要 pnpm 9+（npm i -g pnpm）；一键安装依赖并自动构建全部包
pnpm build        # 手动重新构建：core → server/cli/mcp + web
pnpm clean        # 一键删除依赖：移除根目录及各子包的 node_modules
pnpm start        # http://127.0.0.1:47824
```

> **全平台兼容**：macOS / Windows / Linux 均可运行——Node ≥22.5 + pnpm 即可，零原生编译依赖（SQLite 用 Node 内置模块）。下文 shell 样例是 zsh/bash 语法，Windows 用户把 `&` 换成 `start /b`、或直接用 pm2 托管（见「评论唤醒 agent」的常驻方案对照表）。

# 开发模式（先构建 core，再并行起 server watch + vite 热更新）
pnpm dev          # API :47824, Vite :5174

# CLI（开发期）
pnpm cli -- project create --id my-project --name "My project"
# 或构建后
node apps/cli/dist/cli.js issue list --project my-project
```

常用命令（`taskboard`，构建后可 `pnpm --filter @taskboard/cli link` 全局可用）：

```bash
taskboard project create --id my-project --name "My project" --wake-port 4096 --session-id <会话ID>
taskboard project set --id my-project --session-id <新会话ID>   # 传 '' 清除项目默认会话
taskboard project list                       # 已绑定时显示 session=<id>
taskboard issue create --project my-project --title "搭建登录模块" --priority high --branch feat/login --session-id <会话ID>
taskboard issue create --project my-project --parent <父任务ID> --title "登录表单 UI"   # 省略 --session-id 时继承项目默认会话
taskboard issue done <id> --expected-version 2
taskboard next --project my-project          # 智能取任务：依赖全 done + 优先级排序
taskboard issue claim <id> --agent codex     # 独占租约（默认 30 分钟，taskboard ready --agent 可跳过他人租约）
taskboard search "登录"                       # 全文搜索（标题/描述/评论）
taskboard stats --project my-project         # 统计面板（周吞吐/平均周期/贡献榜）
taskboard progress --project my-project
taskboard project delete skill-test --yes
```


## 5 分钟上手（人类视角）

1. `pnpm install && pnpm start` → 浏览器打开 `http://127.0.0.1:47824`
2. 首次使用可在左侧「全局设置」配置默认工作目录与默认 OpenCode Server URL；该设置保存在 taskboard 数据库中，供所有浏览器客户端共享。新建目录时自动预填这两项，也可以单独填写；两者都为空时不允许创建。更改全局默认值不会改动已有目录或项目
3. 在目录下创建项目时自动继承该目录的工作目录与 OpenCode Server URL，这两项在项目表单中锁定不可修改；项目需要选择已有 Session 或新建 Session。服务端校验所选 Session 的实际目录后才允许绑定
4. 「＋ 新任务」直接继承项目的工作目录、默认 Session 与 OpenCode Server URL，这三项在表单中锁定不可修改；勾选「创建后唤醒 agent 编排」可直接召唤 AI 接手
5. 拖卡片流转状态；拖**父任务**时会询问是否整组移动（子任务跟随）
6. 点卡片开抽屉：改状态/负责人/分支/会话绑定、拆子任务、排依赖、传附件、写评论（输入 @ 唤醒 agent）

## 任务流转与协作规则（人话版）

```
todo → in_progress → in_review → done
```

- **认领即开工**：AI `claim` 一个 todo 任务，状态自动变「进行中」，并把任务绑定到它的会话——卡片上的 👤 徽章告诉你谁在做
- **验收在你手里**：AI 做完只会到「待验收」（in_review）；done 由你在面板点，AI 想跳过验收会被服务器直接拒绝（403 门禁，默认开启）
- **子任务开工，父任务自动亮起**：任一子任务开工，父任务自动从待办进入进行中（单向；父任务的验收与关闭永远人工）
- **删除都有二次确认**：小操作（评论/依赖边）原位两步确认，大操作（任务/批量）应用内弹窗，整个项目要手输 id
- **每个 AI 干活都留痕**：活动流记录谁在何时做了什么；乐观锁保证多 AI 并发互不覆盖
- **开工必绑（默认开启）**：agent 认领/流转任务必须带 `sessionId` 与当前分支名——缺了会被 403 挡住并给出补齐方法（`TASKBOARD_REQUIRE_SESSION=0` 退出）
- **评论编辑权保护**：只有网页用户能编辑自己发的评论；agent 写下的评论永远原样，防止事后篡改

## 面板一览与功能速览

**看板主视图**（暗色终端风，四列流转，各列独立滚动，顶栏/工具栏常驻）：

![看板主视图](docs/screenshots/board.png)

**任务抽屉**（全字段编辑、子任务、依赖、评论、附件、活动流一屏全览）：

![任务抽屉](docs/screenshots/drawer.png)

**拖拽流转**（跨列拖拽带浮层预览，拖父任务可整组移动）：

![拖拽](docs/screenshots/drag.png)

<details>
<summary><strong>更多界面截图</strong>（新建任务 / 确认弹窗 / 自定义下拉 / 时间线 / 统计 / 快捷键）</summary>

新建任务——勾选「创建后唤醒 agent 编排」可直接召唤 AI 接手：

![新建任务](docs/screenshots/new-issue.png)

删除等危险操作走应用内确认弹窗（带焦点陷阱与 ESC）：

![确认弹窗](docs/screenshots/confirm.png)

全站下拉均为自绘 listbox（键盘 ↑↓/Enter/Esc 可导航）：

![自定义下拉](docs/screenshots/select.png)

时间线视图 📅（甘特 lite）：

![时间线](docs/screenshots/timeline.png)

统计面板 📊（周吞吐/平均周期/贡献榜）：

![统计](docs/screenshots/stats.png)

快捷键帮助（`?` 呼出）：

![快捷键](docs/screenshots/shortcuts.png)

</details>

## 面板功能速览

- 拖拽流转、批量模式、泳道分组（按负责人/标签）、逾期与今日截止过滤
- 时间线视图 📅（甘特 lite）、统计面板 📊（周吞吐/平均周期/贡献榜）
- 快捷键：`/` 搜索 · `n` 新建 · `j/k` 上下移动 · `Enter` 打开 · `?` 全部帮助
- 附件上传下载（每任务 ≤20 个/总量 ≤50MB）、桌面通知、暗/亮主题
- 全局设置保存新建目录的默认工作目录与默认 OpenCode Server URL（跨浏览器共享）；左侧目录用于分组管理项目，并保存工作目录与 Server URL；在目录下新建项目时这两项自动继承且锁定，项目只需绑定默认 Session；绑定 Session 时服务端会校验该 Session 的实际目录。新建任务自动锁定项目的工作目录、默认 Session 与 Server URL，不必重复填写；任务保存实际执行的 `sessionId`，唤醒时继续原会话上下文。目录行「目录操作」菜单提供重命名、修改工作目录、修改 Server URL、移除目录；移除需二次确认，并级联删除目录下的全部项目、任务、评论与附件

## 评论唤醒 agent（watch 侧车）

面板**不绑定任何 agent 工具**：Claude Code / Codex / Cursor / opencode / 任何「命令行接 prompt」的 CLI agent 都能被醒。`taskboard watch` 常驻订阅看板事件（macOS / Windows / Linux 均可，常驻方案见下表）。已绑定 `sessionId` 的任务会优先通过 OpenCode v1 `POST /session/:id/prompt_async` 发送到原会话；只有未绑定任务才走 TUI 输入框或 headless 新会话：

```bash
taskboard watch --tui-url http://127.0.0.1:4096   # ① 可选：指令进 opencode TUI 输入框（opencode 专属增强）
taskboard watch --opencode http://127.0.0.1:4096  # ② 建议：绑定任务通过 OpenCode v1 prompt_async 续原会话
taskboard watch                                   # ③ 默认兜底：headless 全新会话，适配所有 agent CLI
```

**各 agent 工具怎么接（换代码就换通道）：** 通道①②依赖 opencode 的 TUI/会话协议，是 opencode 的进阶体验；通道③是通用兜底——`--exec` 指定任意 agent CLI，`watch` 把唤醒 prompt 尾参递给它执行全新会话（agent 拿到 prompt 后经 MCP 工具自行读板干活，见「接入 agent 工具」）：

```bash
taskboard watch --exec "claude -p"                     # Claude Code（print 模式）
taskboard watch --exec "codex exec"                    # Codex CLI
taskboard watch --exec "cursor-agent -p"               # Cursor CLI
taskboard watch                                        # opencode run（默认）
```

> 模型注意：`--model` 走 opencode 的 `-m` 约定；Claude/Codex 用自家 `--model` 参数时直接写进 `--exec`（如 `--exec "claude --model sonnet -p"`），不要混用 `--model`。

**目录分组 + 项目会话绑定**：左侧目录是项目分组并保存工作目录与 OpenCode Server URL；在目录下新建项目时这两项自动继承且锁定，项目只需绑定默认 Session（可选择已有 Session，或通过「新建 Session」按钮在指定工作目录中创建）。新建任务直接继承并锁定项目的工作目录、Session 与 Server URL。`@agent` 评论对已绑定任务直接发往对应 Server 的 `prompt_async`，未绑定任务才注入 TUI。项目路由存在数据里，改绑即时生效，**一只 watch 覆盖所有项目**。CLI 等价：`taskboard project create --wake-port 4097`、改绑 `taskboard project set --id demo --wake-port 4099`；项目也可带标签（`--labels roadmap,work`，侧栏展示为金色小字）。不跑 TUI 注入（纯 headless 的 Claude/Codex/Cursor 工作流）时留空即可。

### 先把 opencode 终端跑起来（watch 的目的地）

TUI 注入需要「在跑的 opencode serve + 附着它的终端」，两种开法：

**A 单实例（最简）**：直接跑交互式 `opencode`（自带 server，端口见 TUI 状态栏），把它绑给主项目：

```bash
opencode                                   # 终端 1：交互式 TUI
# 面板建项目不用填端口（服务端默认解析到 127.0.0.1:4096）；换端口用 project set --wake-port <端口>
```

**B 多实例（多终端接管不同项目，推荐）**：每终端一组 serve + attach，端口互不重复。serve 是一次性部署，交给进程管理器常驻（mac/linux 用后台方式即可零依赖上手；Windows 推荐 pm2，见下方对照表），日常每终端只有一条命令：

```bash
# ── 一次性部署（macOS / Linux，Windows 见下表）─────────────
opencode serve --port 4096 &                # 无界面 server，交给进程管理器常驻
opencode serve --port 4097 &
# 面板「新建项目」不用填服务地址（默认 127.0.0.1:4096 或 TASKBOARD_OPENCODE_URL）；多实例换端口用 taskboard project set --wake-port …

# ── 用户日常（每只终端一个 attach，全平台相同）──────────────
opencode attach http://127.0.0.1:4096        # 终端 1：接管绑定了 4096 的项目
opencode attach http://127.0.0.1:4097        # 终端 2：接管绑定了 4097 的项目
```

**常驻方案对照（macOS / Windows / Linux 全覆盖）**：`opencode serve --port N` 与 `taskboard watch …` 都是普通进程，谁来托管无差别：

| 平台 | 快速上手 | 常驻（开机自启 + 崩溃自愈） |
|---|---|---|
| macOS / Linux | 命令后加 `&`（或 systemd 用户单元） | launchd：`ai.taskboard.*` plist；systemd：`systemctl --user enable …` |
| Windows（推荐） | `pm2 start "opencode serve --port 4096" --name serve-4096` | `pm2 save && pm2 startup`（按提示执行） |
| Windows（原生） | `start /b opencode serve --port 4096` | NSSM 注册为 Windows 服务，或 `schtasks /create /sc onstart …` |

- attach 的端口必须对应一个**已经在跑**的 `opencode serve`；attach 只是"界面"，随时断/重连，serve 挂了 watch 自动降级下一通道
- 唤醒时指令出现在该终端 TUI 输入框，**人工回车提交**；不用 TUI 时 watch 不带 `--tui-url`、走 headless

#### 细节备忘

- 看板面板 / 数据永远只有一个（默认 `http://127.0.0.1:47825`）；服务地址与默认会话都存在**项目数据**（`wakeChannel` + `defaultSessionId`），路由就是 `任务 → 项目 → 服务/会话`，没有中心化的路由表；Web 新建项目需选择目录、工作目录、OpenCode Server 与 Session，选中 Session 会自动回填项目名称与工作区，服务端校验 Session 的实际目录后才写入 `wakeChannel`；已有任务保留自己的 `sessionId`，不会被项目会话变更改写
- 唤醒优先级：任务已绑定 `sessionId` → 对应 OpenCode 服务的 `prompt_async`；只有未绑定任务才使用项目 `wake_channel` / `--tui-url` 注入当前 TUI，最后才 headless。绑定会话投递失败时不会静默创建新会话，唤醒评论保持 pending 以便重试
- 同一 serve 端口被多终端 attach 时注入是**广播**（每窗都出现）——多终端请各用各的端口，绑定时不会串
- 端口/项目/终端数量不受限：`wakeChannel` 是完整 URL（可绑局域网另一台机器），单实例锁按 server 端口 + 作用域自动命名字，headless 通道连端口都不需要
- 唤醒评论有生命周期（`pending`→`processing`→`processed`）：watch 唤走一条评论时置「唤醒中」，headless 通道跑完（exit 0）自动置「已处理」；只有 `pending` 的评论可编辑、可被唤醒，编辑保存即重新入队（watch 会再次唤醒，无需重打指令）；已处理/唤醒中的评论锁定编辑，面板评论上直接显示徽章。人工把状态改回 `pending`（面板编辑保存 / CLI `comment edit` / MCP `update_comment`）即再次唤醒；无论新建还是重唤，只要任务停留在待验收/完成，都会自动重开为「进行中」——agent 不会在名义上已结案的看板下干活

## 接入 agent 工具

> **🤖 给 AI 的自包含接入手册：[docs/AI-INTEGRATION.md](docs/AI-INTEGRATION.md)** —— 连接方式、5 步核心工作流、硬规则表、唤醒协议、错误处理。AI 读完该文档即可正确接入，无需其他上下文。

REST API 的完整契约（OpenAPI 3.1）在服务启动后可从 `/api/openapi.json` 获取。

### 方式一：MCP（推荐，Claude Code / Codex / Cursor / opencode 通用）

MCP server 无状态转发到本地 HTTP 服务，服务未运行时自动拉起。工具：

- 项目：`list_projects` `create_project` `delete_project`
- 任务：`list_issues` `show_issue` `create_issue` `update_issue`（乐观锁 version 必填）`delete_issue` `archive_issue` `unarchive_issue`
- 租约：`claim_issue` `heartbeat_issue` `release_issue`（独占租约，默认 30 分钟，过期后他人可直接认领）
- 协作：`add_comment` `add_issue_dependency` `remove_issue_dependency` `list_attachments`
- 视图：`progress` `project_stats` `ready_issues` `next_issue` `search_issues`

```jsonc
// Claude Code (.mcp.json) / Cursor (~/.cursor/mcp.json)
{ "mcpServers": { "taskboard": { "command": "node", "args": ["/abs/path/open-taskboard/apps/mcp/dist/mcp.js"] } } }
```

```toml
# Codex (~/.codex/config.toml)
[mcp_servers.taskboard]
command = "node"
args = ["/abs/path/open-taskboard/apps/mcp/dist/mcp.js"]
```

```json
// opencode (~/.config/opencode/opencode.json)
{ "mcp": { "taskboard": { "type": "local", "command": ["node", "/abs/path/open-taskboard/apps/mcp/dist/mcp.js"] } } }
```

建议同时在 AGENTS.md / rules 中加入：

> 管理任务时使用 taskboard MCP 工具；状态流转 todo → in_progress → in_review → done，**不流转不许开工**（服务端 claim 会把 todo 自动置为 in_progress，认领即开工），done 必须等用户确认；update_issue 必须携带 show_issue 返回的 version（乐观锁）；拆解需求时先建父任务再用 parentId 建子任务；多 agent 并发先 claim 再开工，长任务定期 heartbeat 续租，完成即 release；agent 创建任务带 sessionId（省略时继承项目默认会话），认领未绑定任务用 claim sessionId 绑定自己的会话（只绑空位，不抢绑）。

### 方式二：Skill + CLI（opencode 或不支持 MCP 的工具）

```bash
ln -s /abs/path/open-taskboard/skills/open-taskboard ~/.config/opencode/skill/open-taskboard
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `TASKBOARD_HOST` | `127.0.0.1` | HTTP 绑定地址（LAN 共享改 `0.0.0.0`） |
| `TASKBOARD_PORT` | `47824` | HTTP 端口 |
| `TASKBOARD_DATA_DIR` | `.data` | SQLite 数据目录 |
| `TASKBOARD_URL` | `http://127.0.0.1:47824` | CLI / MCP 指向的服务地址 |
| `TASKBOARD_OPENCODE_URL` | 未设置 | Web 新建项目与无状态 `GET /api/opencode/sessions` 的默认 OpenCode 服务地址。服务端解析顺序：显式 `url` query（仅 API）→ 本环境变量 → 最近创建项目的 `wakeChannel` → `http://127.0.0.1:4096`；解析结果写入新项目的 `wakeChannel`（`未设置` 时走后面三级）。Docker Compose 示例已设为 `http://host.docker.internal:4096`，并加 `host.docker.internal:host-gateway`（Linux） |
| `TASKBOARD_SESSION_ID` | 未设置 | CLI 每次请求自动带 `x-taskboard-session`；`--session-id` 优先于该环境变量 |
| `TASKBOARD_WEB_DIST` | 自动探测 | 看板静态目录（默认 `apps/web/dist`，vite 构建产物） |
| `TASKBOARD_TOKEN` | 未设置 | 设置后 API 需要 Bearer 认证（`Authorization: Bearer <token>` 或 `?token=`；SSE 支持 `?token=`） |
| `TASKBOARD_READONLY` | 未设置 | `1` 时所有写操作（POST/PATCH/DELETE）返回 403，GET/SSE 不受影响 |
| `TASKBOARD_WEBHOOK_URL` | 未设置 | 逗号分隔的 HTTP(S) URL；设置后每个事件（project/issue/comment 变更）以 POST JSON 转发到各 URL（3s 超时，失败重试一次，失败仅告警） |
| `TASKBOARD_WEBHOOK_SECRET` | 未设置 | 设置后 webhook 请求带 `X-Taskboard-Signature: sha256=HMAC-SHA256(body, secret)`，接收端应对原始字节验签后再解析 |
| `TASKBOARD_HUMAN_DONE` | 默认开启 | `done` 门禁：agent 来源置 `done`（PATCH 与 create 皆含）返回 403，除非用户确认后 agent 传 `confirm: true` 代为设置；web 来源（人工 UI）不受影响。纯自动化看板设 `0` 显式关闭 |
| `TASKBOARD_BACKUPS` | 未设置 | `0` 关闭启动备份；默认每次启动 `VACUUM INTO` 快照到 `<dataDir>/backups/`，保留最近 10 份 |

## 功能

- 父子两层任务拆解、四列状态流转（todo → in_progress → in_review → done）；子任务开工自动把 `todo` 父任务拉到 `in_progress`（单向），父任务 `in_review`/`done` 始终人工
- 乐观锁版本（`version` / `--expected-version` / MCP `update_issue` 必填）防并发覆盖
- 独占租约：claim / heartbeat / release，多 agent 并发防碰撞；`next`/`ready` 自动跳过他人租约中的任务
- 依赖阻塞：blocked-by 边 + 循环检测 + 同项目约束；`ready`/`next` 只返回依赖全 done 的任务
- 进度统计：一个顶层任务 = 一个单位（自身 done 或子任务全 done 即完成，父任务等权）
- 评论、活动流、标签、负责人、分支/worktree 绑定、起止日期（校验真实日历）、归档（归档父任务连带其未归档子任务）
- 全文搜索（FTS5 trigram，标题/描述/评论，短查询退化 LIKE）、导出/导入 JSON（taskboard export/import）、统计面板（周吞吐/平均周期/贡献榜）、时间线视图、Mermaid 图渲染
- 附件（元数据入库、正文落盘 `attachments/`，单文件 ≤10MB，每任务限额 20 个/总量 50MB 超限 400）、桌面通知、暗/亮主题、泳道分组、批量操作、j/k 键盘导航
- 评论唤醒 agent：`taskboard watch` 常驻订阅 SSE（`--exec` 适配任意 agent CLI）。已绑定 `sessionId` 的任务优先调用 OpenCode v1 `POST /session/:id/prompt_async`，复用原会话上下文；未绑定任务才走项目 `wake_channel` / `--tui-url` TUI 注入，再到 headless spawn。绑定会话投递失败时不创建新会话，评论保留 pending 供重试；`--on` 可改唤醒前缀，`--project` 可选作用域过滤，`--ignore-author a,b` 按作者忽略唤醒评论（防 agent 自我唤醒循环，`watch` 自身 actor 始终忽略）
- SSE 实时刷新（Web 多端 + 跨 agent 工具共享同一块板；25s 心跳保活，断线指数退避重连 + 全量兜底拉取）
- LAN 共享（`TASKBOARD_HOST=0.0.0.0`）、Bearer 令牌认证、只读模式、人工 done 门禁、webhook 事件转发
