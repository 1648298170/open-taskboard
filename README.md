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

# 开发模式（先构建 core，再并行起 server watch + vite 热更新）
pnpm dev          # API :47824, Vite :5174

# CLI（开发期）
pnpm cli -- project create --id my-project --name "My project"
# 或构建后
node apps/cli/dist/cli.js issue list --project my-project
```

常用命令（`taskboard`，构建后可 `pnpm --filter @taskboard/cli link` 全局可用）：

```bash
taskboard project create --id my-project --name "My project"
taskboard issue create --project my-project --title "搭建登录模块" --priority high --branch feat/login
taskboard issue create --project my-project --parent <父任务ID> --title "登录表单 UI"
taskboard issue done <id> --expected-version 2
taskboard progress --project my-project
taskboard project delete skill-test --yes
```

## 接入 agent 工具

### 方式一：MCP（推荐，Claude Code / Codex / Cursor / opencode 通用）

MCP server 无状态转发到本地 HTTP 服务，服务未运行时自动拉起。工具：`list_projects` `create_project` `delete_project` `list_issues` `show_issue` `create_issue` `update_issue`（乐观锁 version 必填）`delete_issue` `add_comment` `progress`。

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

> 管理任务时使用 taskboard MCP 工具；状态流转 todo → in_progress → in_review → done，done 必须等用户确认；update_issue 必须携带 show_issue 返回的 version（乐观锁）；拆解需求时先建父任务再用 parentId 建子任务。

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
| `TASKBOARD_WEB_DIST` | 自动探测 | 看板静态目录（默认 `apps/web/dist/web`） |
| `TASKBOARD_TOKEN` | 未设置 | 设置后 API 需要 Bearer 认证（`Authorization: Bearer <token>` 或 `?token=`；SSE 支持 `?token=`） |
| `TASKBOARD_WEBHOOK_URL` | 未设置 | 逗号分隔的 HTTP(S) URL；设置后每个事件（project/issue/comment 变更）以 POST JSON 转发到各 URL（3s 超时，失败重试一次，失败仅告警） |

## 功能

- 父子两层任务拆解、四列状态流转（todo → in_progress → in_review → done）
- 乐观锁版本（`version` / `--expected-version` / MCP `update_issue` 必填）防并发覆盖
- 评论、分支/负责人绑定、优先级、标签
- 进度统计：一个顶层任务 = 一个单位（自身 done 或子任务全 done 即完成，父任务等权）
- SSE 实时刷新（Web 多端 + 跨 agent 工具共享同一块板）
- LAN 共享（`TASKBOARD_HOST=0.0.0.0`）

## Legacy（已清除）

历史单包版本（根部 `src/`、`web/`、根部 `vite.config.ts`/`tsconfig.json`、`packages/{server,cli,mcp}/`）已物理删除，不再存在于仓库中。当前结构仅保留 `apps/` + `packages/core` + `skills/`。
