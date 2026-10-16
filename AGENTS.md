# AGENTS.md

面向 agent 工具的仓库须知（open-taskboard）。

## 这是什么仓库

本地优先（local-first）的任务看板，为 opencode 及任何 agent 工具服务——看任务、拆解任务、跟踪任务。
pnpm monorepo；SQLite 使用 Node 22.5+ 内置 `node:sqlite`，零原生编译依赖。

## 目录结构

```
apps/server    @taskboard/server   Fastify：REST + SSE + 静态托管看板（端口 47824）
apps/web       @taskboard/web      Vite + React 看板（单一手写暗色 terminal 风格 stylesheet）
apps/cli       @taskboard/cli      taskboard 命令行（依赖 server 的 startServer）
apps/mcp       @taskboard/mcp      MCP server（bin: taskboard-mcp，无状态转发 HTTP）
packages/core  @taskboard/core     类型 + Store（node:sqlite），四端共享
skills/open-taskboard              opencode skill（工作流纪律）
```

## 构建 / 测试

```bash
pnpm install    # postinstall 自动构建全部包
pnpm build      # 手动全量构建（core → server/cli/mcp + web）
pnpm typecheck  # 全部包 tsc --noEmit
pnpm test       # 全部包测试
pnpm start      # 启动服务：http://127.0.0.1:47824
```

改动任何包后先 `pnpm build` 再验证；提交前 `pnpm typecheck && pnpm test` 必须通过。

## 环境变量

`TASKBOARD_HOST`（默认 127.0.0.1，LAN 共享用 0.0.0.0）· `TASKBOARD_PORT`（47824）·
`TASKBOARD_DATA_DIR`（.data）· `TASKBOARD_URL` · `TASKBOARD_WEB_DIST` ·
`TASKBOARD_TOKEN`（设置后 API 需要 Bearer 认证；SSE 支持 `?token=`）·
`TASKBOARD_WEBHOOK_URL`（逗号分隔 URL，事件以 POST JSON 转发），详见 README.md。

## taskboard 使用纪律（重要）

- 状态流转严格遵循：`todo → in_progress → in_review → done`。
- `done` 必须等用户确认后才能设置；自验完成先置 `in_review` 并在评论写明验证方式。
- `update_issue` 必须携带 `show_issue` 返回的 `version`（乐观锁）；版本冲突说明别人改过，重读再改。
- 拆解需求：先建父任务（顶层），再用 parentId 建子任务（仅两层），一个可独立交付的子需求一个任务。
- 进展与重要结论写入评论（`add_comment`），不要只留在对话里。
- 顶层父任务在所有子任务 done 后才算完成，不要提前关闭父任务。

完整工作流见 `skills/open-taskboard/SKILL.md`。

## MCP / Skill 接入

MCP 配置示例（Claude Code / Codex / Cursor / opencode）见 README.md；
opencode 也可用 `skills/open-taskboard` skill + CLI 两种等价方式操作。
