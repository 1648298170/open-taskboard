# AGENTS.md

面向 agent 工具的仓库须知（open-taskboard）。

> 要把**外部 AI 接入本看板**（而非开发本仓库）？直接读 **[docs/AI-INTEGRATION.md](docs/AI-INTEGRATION.md)**——自包含的接入与工作流手册。

## 这是什么仓库

本地优先（local-first）的任务看板，为 opencode 及任何 agent 工具服务——看任务、拆解任务、跟踪任务。
pnpm monorepo；SQLite 使用 Node 22.5+ 内置 `node:sqlite`（启动日志有 ExperimentalWarning 属正常），零原生编译依赖。

## 目录结构

```
apps/server    @taskboard/server   Fastify：REST + SSE + 静态托管看板（端口 47824，路由插件在 src/routes/）
apps/web       @taskboard/web      Vite + React 看板（单一手写暗色 terminal stylesheet，暗/亮双主题）
apps/cli       @taskboard/cli      taskboard 命令行（命令注册表在 src/commands/，依赖 server 的 startServer）
apps/mcp       @taskboard/mcp      MCP server（工具注册表在 src/tools/，无状态转发 HTTP）
packages/core  @taskboard/core     领域层：repos + Store 门面 + events + transactions + migrations + zod schemas
skills/open-taskboard              opencode skill（工作流纪律）
```

## 构建 / 测试 / 验证

```bash
pnpm install    # postinstall 自动构建全部包
pnpm build      # 全量构建（拓扑序：core → server/cli/mcp + web）；改任何包后必须先 build 再验证
pnpm typecheck  # 全部包 tsc --noEmit
pnpm test       # 全部包测试（core 用 node:test + tsx，66 个用例，':memory:' 注入无文件 IO）
pnpm start      # 启动服务 http://127.0.0.1:47824（0.0.0.0 时额外打印 LAN 地址）
```

提交前 `pnpm typecheck && pnpm test` 必须通过。新增 Store 能力必须带测试（参考 `packages/core/test/store.test.ts`，用注入 `DatabaseSync(':memory:')` 的 DI 接缝，不用真实文件）。

## 架构规范（新增功能必须遵守）

- **分层**：core 是唯一领域层（`repos/` 仓库模式 + `Store` 门面 + `events.ts` 事件总线 + `transactions.ts` 事务 UoW）；server 只做路由插件；cli 只做命令注册表；mcp 只做工具注册表；web 只做展示。禁止把领域逻辑写进 server/cli/mcp。
- **依赖注入**：Store 构造器接受注入 `DatabaseSync`（测试接缝）；路由插件经 opts 接收 store；cli 命令经 ctx 注入 api client；mcp 工具经注册表分发。不要在模块内部 new 依赖。
- **schema 变更只能走迁移**：改表结构 = 在 `packages/core/src/db.ts` 的 `MIGRATIONS` 数组追加一项（`PRAGMA user_version` 驱动），禁止在别处散落 ALTER。types.ts、ISSUE_COLS、zod schema 同步更新。
- **校验单一来源**：所有请求体校验的 zod schema 定义在 `packages/core/src/schemas.ts`（经 `./schemas` 子路径导出）；server 路由 `safeParse` → `ValidationError` → 全局错误处理 400；枚举只能 import `STATUSES`/`PRIORITIES`，禁止字面量数组。
- **写路径三件套**：多语句变更用 `inTransaction` 包裹；`logActivity` 记录活动（actor 经 `x-taskboard-actor` 头传播）；`emit` 事件必须在 COMMIT 之后。空 patch 不 bump version、不发事件。
- **五端同步**：任何 API 变更 = core schema/types → server 路由 → CLI 命令 → MCP 工具 → Web UI → `apps/server/openapi.json`，六处缺一不可。
- **设计模式约定**：仓库模式（repos/）、门面（Store）、注册表 + 策略（cli/mcp）、观察者（EventBus/SSE/webhook）、工厂（createDatabase/buildApp）。新功能先找现有接缝，避免单文件堆砌与透传层。

## taskboard 使用纪律（重要）

- 状态流转严格遵循：`todo → in_progress → in_review → done`。**不流转不许开工**：服务端 `claim` 会把 `todo` 自动置为 `in_progress`（认领即开工）——开工必须先 claim，不存在"干着活但状态还在 todo"的合法状态。
- `done` 必须等用户确认后才能设置；自验完成先置 `in_review` 并在评论写明验证方式；服务端可用 `TASKBOARD_HUMAN_DONE=1` 强制——届时 agent 来源改 done 将被 403 拒绝，除非用户已确认且请求带 `confirm: true`。
- `update_issue` 必须携带 `show_issue` 返回的 `version`（乐观锁）；版本冲突说明别人改过，重读再改。认领冲突（409）同理：重读一次，条件不变才重试，**绝不抢他人的认领**。
- **多 agent 并发**：开工前先 `claim`（租约默认 30 分钟，todo 任务认领即自动流转 in_progress），长任务定期 `heartbeat` 续租，完成即 `release`；`next`/`ready` 会自动跳过他人租约中的任务。
- **开工必绑（硬性规则）**：claim / PATCH 流转 `in_progress` 必须携带 `sessionId` 与 `branch`（认领即绑定，只绑空位不抢绑）——缺失会被 403 拒绝并附教学文案，重试补齐即可；人工 web 来源与 `confirm: true` 豁免；纯自动化看板可用 `TASKBOARD_REQUIRE_SESSION=0` 退出。**评论编辑权**：只有网页用户可编辑自己发的评论，agent 创建的评论永远不可编辑（状态推进不受限）。
- **目录与项目绑定**：左侧目录是逻辑分组，不是文件系统路径；每个项目独立保存 `workspacePath`、`wakeChannel`（OpenCode Server URL）和可选 `defaultSessionId`。Web 新建项目时必须先选择或新建一个属于该项目工作目录的 Session；新建任务默认预选项目的 `defaultSessionId`，但任务可以选择同目录下的其他 Session。Agent 创建任务可带自己的 `sessionId`；认领未绑定任务时传 `claim --session-id` / `claim_issue sessionId`（认领即绑定，只绑空位）；**已绑他人会话不抢绑**——绑定即所有权，接管需显式解绑。
- **会话唤醒必须同会话**：已绑定 `sessionId` 的任务使用 OpenCode v1 `POST /session/:id/prompt_async`；不得投到当前 TUI 选中会话，也不得静默 fallback 到新 headless 会话。投递失败时保持唤醒评论 `pending`，修复服务地址后重试。未绑定任务才允许 TUI/headless fallback。
- **唤醒收尾必推评论**：agent 被 `@agent` 评论唤醒并处理完后，把该评论置 `processed`（TUI 注入通道 watch 观测不到完工，headless 才有 exit-0 自动标）；漏推则面板任务完成后评论仍挂「唤醒中」。
- 拆解需求：先建父任务（顶层），再用 parentId 建子任务（仅两层），一个可独立交付的子需求一个任务。子任务开工（认领或手动流转）会自动把 `todo` 父任务拉到 `in_progress`（单向）；父任务的 `in_review`/`done` 始终人工——全子 done 也不自动关闭父任务。
- 进展与重要结论写入评论（`add_comment`），不要只留在对话里；有依赖关系用 dep-add 标注，不要靠对话约定。
- 顶层父任务在所有子任务 done 后才算完成，不要提前关闭父任务。

常用命令：`taskboard next|ready`（智能取任务）、`search "关键词"`（全文搜索）、`export`（导出 JSON/MD）、`stats`（统计）。

完整工作流见 `skills/open-taskboard/SKILL.md`。

## 环境变量

`TASKBOARD_HOST`（默认 127.0.0.1，LAN 共享用 0.0.0.0）· `TASKBOARD_PORT`（47824）·
`TASKBOARD_DATA_DIR`（.data）· `TASKBOARD_URL` · `TASKBOARD_WEB_DIST` ·
`TASKBOARD_TOKEN`（设置后 API 需 Bearer；SSE 支持 `?token=`）·
`TASKBOARD_READONLY=1`（写操作 403）· `TASKBOARD_HUMAN_DONE=1`（done 仅限 web 来源；agent 可带 `confirm: true` 代为设置）·
`TASKBOARD_WEBHOOK_URL`（逗号分隔，事件 POST JSON 转发）· `TASKBOARD_BACKUPS=0`（关闭启动备份）。
详见 README.md。

## MCP / Skill 接入

MCP 配置示例（Claude Code / Codex / Cursor / opencode）见 README.md；
opencode 也可用 `skills/open-taskboard` skill + CLI 两种等价方式操作。
API 机器可读契约：`GET /api/openapi.json`（OpenAPI 3.1）。
