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

## Windows 一键启动（推荐本地使用）

Windows 10/11 用户可双击仓库根目录的 `start.bat`。启动器会检查 Node.js/pnpm 版本、首次安装依赖、构建产物、端口占用与 API 健康状态；服务日志写入 `.taskboard-runtime/`，不会自动杀掉未知进程。

- 使用说明与故障场景：[`docs/WINDOWS-STARTUP.md`](docs/WINDOWS-STARTUP.md)
- 命令行管理：`powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\taskboard.ps1 -Action status`
- 支持操作：`start`、`stop`、`restart`、`status`、`logs`

该启动器用于本机手动启动，不提供开机自启或崩溃自动拉起；脚本仍需在真实 Windows 环境中验证。

# 开发模式（先构建 core，再并行起 server watch + vite 热更新）
pnpm dev          # API :47824, Vite :5174

# CLI（开发期）
pnpm cli -- project create --id my-project --name "My project"
# 或构建后
node apps/cli/dist/cli.js issue list --project my-project
```

常用命令（`taskboard`，构建后可 `pnpm --filter @taskboard/cli link` 全局可用）：

```bash
taskboard project create --id my-project --name "My project" --workspace-path <工作目录> --session-id <会话ID>
taskboard project set --id my-project --session-id <新会话ID>   # 传 '' 清除项目默认会话
taskboard project list                       # 已绑定时显示 session=<id>
taskboard issue create --project my-project --title "搭建登录模块" --priority high --branch feat/login --session-id <会话ID>
taskboard issue create --project my-project --parent <父任务ID> --title "登录表单 UI"   # 省略 --session-id 时继承项目默认会话
taskboard issue update <id> --status in_review --expected-version 2 --status-note "完成原因；验证证据；未覆盖项"
taskboard issue done <id> --expected-version 3 --status-note "确认原因；验证证据；未覆盖项"
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
- **子任务开工，父任务自动流转**：任一子任务开工，父任务自动从待办进入进行中；所有子任务进入待验收或完成后，父任务自动进入待验收（in_review）；父任务的最终 done 始终人工
- **删除都有二次确认**：小操作（评论/依赖边）原位两步确认，大操作（任务/批量）应用内弹窗，整个项目要手输 id
- **每个 AI 干活都留痕**：活动流记录谁在何时做了什么；乐观锁保证多 AI 并发互不覆盖
- **开工 Session 校验（默认开启）**：Agent 认领或将任务流转到进行中时，所属项目必须配置默认 OpenCode Session；请求中携带的任务级 `sessionId` 不会绕过校验。Git 分支、工作树和负责人由 Agent 维护（`TASKBOARD_REQUIRE_SESSION=0` 可退出该校验）。
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
- 全局设置仅提供新建目录时的默认工作目录和默认 OpenCode Server URL。目录是工作目录配置的唯一来源，目录下所有项目自动继承；目录右键菜单可修改工作目录并查看 OpenCode 运行状态。修改工作目录会更新目录下项目继承的工作路径，并影响后续 Session 列表查询，但不会清除项目的默认 Session 绑定，也不会删除 OpenCode 历史会话；旧 Session 的实际目录若与新路径不同，相关执行或状态查询可能提示目录不匹配，可在项目右键菜单中主动重新绑定。相关任务存在有效 Agent 认领时仍会拒绝修改。项目右键菜单配置项目默认 Session，任务自动继承；任务属性里的 Session、Git 分支、工作树、工作树路径和负责人均只读，由项目配置或 Agent 写入。项目删除与目录删除仍会二次确认并级联删除对应数据。

## 评论唤醒 agent（watch 侧车）

面板**不绑定任何 agent 工具**：Codex、Cursor、OpenCode 或任意 CLI Agent 都可以通过 Taskboard API/MCP 协作。`taskboard watch` 常驻订阅看板事件；任务 Session 由 `Project.defaultSessionId` 统一提供，唤醒时继续使用项目配置的会话；项目尚未配置 Session 时才走项目 Directory 的 OpenCode Server 路由或 headless fallback。

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

**目录分组 + 项目会话绑定**：左侧目录只保存工作目录，项目绑定默认 Session；OpenCode Server URL 由 Taskboard 服务端的 `TASKBOARD_OPENCODE_URL` 统一配置，目录、项目和全局设置不再保存或修改 URL。Session 跳转链接使用独立的 `TASKBOARD_OPENCODE_PUBLIC_URL`，必须配置为浏览器可访问的地址。

### 先把 opencode 终端跑起来（watch 的目的地）

TUI 注入需要「在跑的 opencode serve + 附着它的终端」，两种开法：

**A 单实例（最简）**：直接跑交互式 `opencode`（自带 server，端口见 TUI 状态栏），把它绑给主项目：

```bash
opencode                                   # 终端 1：交互式 TUI
# OpenCode Server 地址由服务端 TASKBOARD_OPENCODE_URL 统一配置；不再通过 project set 修改项目 URL
```

**B 多实例（多终端接管不同项目，推荐）**：每终端一组 serve + attach，端口互不重复。serve 是一次性部署，交给进程管理器常驻（mac/linux 用后台方式即可零依赖上手；Windows 推荐 pm2，见下方对照表），日常每终端只有一条命令：

```bash
# ── 一次性部署（macOS / Linux，Windows 见下表）─────────────
opencode serve --port 4096 &                # 无界面 server，交给进程管理器常驻
opencode serve --port 4097 &
# OpenCode Server 地址由部署环境配置，不通过项目或目录命令修改

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

- 看板面板 / 数据永远只有一个（默认 `http://127.0.0.1:47824`）。工作目录存在 **Directory**（`workspacePath`），项目通过 `directoryId` 继承；默认会话保存在 **Project**（`defaultSessionId`），所有任务从所属项目读取同一个 Session。OpenCode Server 地址只由 Taskboard 服务端环境变量 `TASKBOARD_OPENCODE_URL` 配置，目录、项目和全局设置均不保存或修改该地址。任务表不再存储独立 `sessionId`，任务级会话输入不会覆盖项目绑定。新建项目需选择目录和项目默认 Session，服务端会按统一部署地址校验 Session 的实际工作目录。
- 唤醒优先级：任务通过所属项目继承 `defaultSessionId`；所有 OpenCode 操作统一使用服务端部署配置 `TASKBOARD_OPENCODE_URL`。目录和项目只保存工作目录、Session 等业务数据，不保存 OpenCode URL。
- 同一 serve 端口被多终端 attach 时注入是**广播**（每窗都出现）——多终端请各用各的端口，绑定时不会串
- 端口/项目/终端数量不受限：Taskboard 内部访问 OpenCode 使用 `TASKBOARD_OPENCODE_URL`；浏览器跳转使用 `TASKBOARD_OPENCODE_PUBLIC_URL`。两者可以不同，不能将容器内部地址直接当作浏览器可访问地址。
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

> 管理任务时使用 Taskboard MCP 工具；状态流转 todo → in_progress → in_review → done，**不流转不许开工**（服务端 claim 会把 todo 自动置为 in_progress，认领即开工）；done 必须等用户确认。`update_issue` 必须携带 `show_issue` 返回的 version（乐观锁）；每次通过 `update_issue`/PATCH 实际变更状态都必须在同一请求传 `statusNote`（原因、验证证据、未覆盖项），服务端在同一事务保存状态和审计评论。拆解需求时先建父任务再用 `parentId` 建子任务；多 Agent 并发先 claim 再开工，长任务定期 heartbeat 续租，完成即 release。任务 Session 由 Project 默认 Session 继承；不要尝试通过任务级 `sessionId` 覆盖绑定。分支、工作树及负责人等执行属性由 Agent 写回任务。

### 方式二：Skill + CLI（opencode 或不支持 MCP 的工具）

```bash
ln -s /abs/path/open-taskboard/skills/open-taskboard ~/.config/opencode/skill/open-taskboard
```

## Docker 部署（Web + Server）

仓库当前使用**单容器部署**：同一个 Taskboard 容器托管 React 静态页面与 Fastify API；不需要为 Web 和 Server 分别配置容器 DNS。

```bash
docker compose up -d --build
```

- 本机访问：`http://127.0.0.1:47824`
- 局域网访问：`http://192.168.3.7:47824`（以宿主机实际 LAN IP 为准）
- 宿主机端口 `47824` 映射至容器端口 `47824`。
- 首次访问进入管理员初始化页，创建用户名和至少 12 位密码；初始化完成后只能登录，公开初始化入口不能覆盖已有账号。
- 密码哈希与看板数据保存在持久化卷 `taskboard-data` 中。浏览器认证采用 HttpOnly、SameSite=Strict Cookie，不使用 localStorage 或 URL Token。
- Compose 默认让 Taskboard 通过 `host.docker.internal:4096` 访问 Windows 宿主机上的 OpenCode Server。OpenCode 必须监听可从 Docker 到达的地址；如需更改监听范围，请同时限制 Windows 防火墙，避免把 OpenCode API 暴露给不可信网络。
- 当前示例通过 HTTP 提供局域网访问；不建议直接暴露到公网。跨不可信网络访问应配置 HTTPS 与防火墙/反向代理。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `TASKBOARD_HOST` | `127.0.0.1` | HTTP 绑定地址（LAN 共享改 `0.0.0.0`） |
| `TASKBOARD_PORT` | `47824` | HTTP 端口 |
| `TASKBOARD_DATA_DIR` | `.data` | SQLite 数据目录 |
| `TASKBOARD_URL` | `http://127.0.0.1:47824` | CLI / MCP 指向的服务地址 |
| `TASKBOARD_OPENCODE_URL` | Docker Compose 默认 `http://host.docker.internal:4096` | Taskboard 服务端访问 OpenCode 的内部地址。该值仅由部署环境配置，不存入目录、项目或应用设置。 |
| `TASKBOARD_OPENCODE_PUBLIC_URL` | 未设置 | 浏览器可访问的 OpenCode 地址，用于生成 Session 跳转链接。Docker 部署时不要填写 `host.docker.internal`；请设置为浏览器能访问的宿主机 IP、域名及端口。 |
| `TASKBOARD_SESSION_ID` | 未设置 | CLI 每次请求自动带 `x-taskboard-session`；`--session-id` 优先于该环境变量 |
| `TASKBOARD_WEB_DIST` | 自动探测 | 看板静态目录（默认 `apps/web/dist`，vite 构建产物） |
| `TASKBOARD_AUTH_REQUIRED` | 未设置 | `1` 时强制浏览器登录；非回环监听地址也会自动强制登录。首次访问创建管理员，后续通过 HttpOnly Session Cookie 认证，无需手动输入 Token |\n| `TASKBOARD_TOKEN` | 未设置 | 可选的兼容凭证，供 CLI/MCP 等机器客户端使用；浏览器不再要求输入或保存此值 |
| `TASKBOARD_READONLY` | 未设置 | `1` 时所有写操作（POST/PATCH/DELETE）返回 403，GET/SSE 不受影响 |
| `TASKBOARD_WEBHOOK_URL` | 未设置 | 逗号分隔的 HTTP(S) URL；设置后每个事件（project/issue/comment 变更）以 POST JSON 转发到各 URL（3s 超时，失败重试一次，失败仅告警） |
| `TASKBOARD_WEBHOOK_SECRET` | 未设置 | 设置后 webhook 请求带 `X-Taskboard-Signature: sha256=HMAC-SHA256(body, secret)`，接收端应对原始字节验签后再解析 |
| `TASKBOARD_HUMAN_DONE` | 默认开启 | `done` 门禁：agent 来源置 `done`（PATCH 与 create 皆含）返回 403，除非用户确认后 agent 传 `confirm: true` 代为设置；web 来源（人工 UI）不受影响。纯自动化看板设 `0` 显式关闭 |
| `TASKBOARD_BACKUPS` | 未设置 | `0` 关闭启动备份；默认每次启动 `VACUUM INTO` 快照到 `<dataDir>/backups/`，保留最近 10 份 |

## 功能

- 父子两层任务拆解、四列状态流转（todo → in_progress → in_review → done）；子任务开工自动把 `todo` 父任务拉到 `in_progress`；所有子任务进入 `in_review`/`done` 时父任务自动进入 `in_review`，最终 `done` 始终人工
- 乐观锁版本（`version` / `--expected-version` / MCP `update_issue` 必填）防并发覆盖
- 独占租约：claim / heartbeat / release，多 agent 并发防碰撞；`next`/`ready` 自动跳过他人租约中的任务
- 依赖阻塞：blocked-by 边 + 循环检测 + 同项目约束；`ready`/`next` 只返回依赖全 done 的任务
- 进度统计：一个顶层任务 = 一个单位（自身 done 或子任务全 done 即完成，父任务等权）
- 评论、活动流、标签、负责人、分支/worktree 绑定、起止日期（校验真实日历）、归档（归档父任务连带其未归档子任务）
- 全文搜索（FTS5 trigram，标题/描述/评论，短查询退化 LIKE）、导出/导入 JSON（taskboard export/import）、统计面板（周吞吐/平均周期/贡献榜）、时间线视图、Mermaid 图渲染
- 附件（元数据入库、正文落盘 `attachments/`，单文件 ≤10MB，每任务限额 20 个/总量 50MB 超限 400）、桌面通知、暗/亮主题、泳道分组、批量操作、j/k 键盘导航
- 评论唤醒 Agent：`taskboard watch` 常驻订阅 SSE。绑定项目默认 Session 时，服务端通过部署配置的 OpenCode 地址投递 `prompt_async`；目录、项目和全局设置均不维护 OpenCode URL。
- SSE 实时刷新（Web 多端 + 跨 agent 工具共享同一块板；25s 心跳保活，断线指数退避重连 + 全量兜底拉取）
- LAN 共享（`TASKBOARD_HOST=0.0.0.0`）、首次初始化管理员 + Session Cookie 登录、只读模式、人工 done 门禁、webhook 事件转发
