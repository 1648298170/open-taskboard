# 多 Agent 统一调度技术方案

> 文档状态：方案设计（待评审，尚不代表功能已实现）  
> 适用项目：Open Taskboard  
> 目标 Agent：OpenCode、OpenAI Codex、Claude Code  
> 建议实施方式：在现有架构上增量演进，先实现统一任务执行，再扩展会话管理与多 Agent 工作流。

## 1. 背景与目标

当前 Taskboard 已有 OpenCode 相关集成能力。为避免看板长期绑定单一 Agent，需要建立统一的 Agent 接入层，使用户能够在一个面板中选择不同的编程 Agent、启动任务、查看执行状态与日志，并在后续扩展会话恢复、Review 和自动化工作流。

### 1.1 目标

- 在同一任务看板中接入 OpenCode、Codex、Claude Code。
- 统一启动、状态查询、日志事件、取消和结果记录等通用操作。
- 每次执行都绑定明确的项目、工作目录和可追踪的执行记录。
- 支持 Git Worktree 隔离，降低并行 Agent 修改同一工作区的风险。
- 通过适配器隔离各 Agent 的 CLI、HTTP API、SDK、会话协议和版本差异。
- 为后续增加其他 Agent、远程 Runner、多 Agent 协作预留扩展点。
- 保留 Agent 原始事件与错误信息，便于排障和审计。

### 1.2 非目标（第一阶段不做）

- 不在第一阶段实现复杂的自主 Agent 编排或无限递归的 Agent-to-Agent 调用。
- 不要求三种 Agent 的会话、工具调用和权限机制完全一致。
- 不自动批准高风险命令，不绕过 Agent 自身的权限确认。
- 不把用户认证凭据明文存储到任务表、日志或前端。
- 不要求立即实现跨机器分布式调度。

## 2. 核心设计原则

1. **统一任务，不统一所有底层细节。** 对外暴露稳定的通用接口；Agent 独有能力通过能力声明和适配器扩展。
2. **任务与执行分离。** 一个看板任务可以有多次执行记录，也可以先后使用不同 Agent。
3. **执行环境明确。** 每次执行都记录 Runner、工作目录、Git 分支/Worktree、Agent 类型及版本。
4. **优先隔离。** 默认每个执行任务使用独立 Worktree；复用已有目录需要明确选择。
5. **事件驱动、状态持久化。** UI 不依赖单个长 HTTP 请求；服务重启后应能恢复或准确标记执行状态。
6. **最小权限。** Runner 与 Agent 进程使用受控权限、超时、并发限制和网络访问策略。
7. **渐进式交付。** 先让三种 Agent 可靠执行任务，再做会话恢复，最后实现编排与 Review 闭环。

## 3. 总体架构

```text
┌─────────────────────────────────────────────────────────────┐
│                         Taskboard Web                       │
│ Agent 选择 / 启动任务 / 运行详情 / 日志 / 取消 / Review       │
└──────────────────────────────┬──────────────────────────────┘
                               │ REST API + SSE
┌──────────────────────────────▼──────────────────────────────┐
│                    Taskboard Server                         │
│ API Routes / Auth / Task Scheduler / Run State Machine      │
│ Job Queue / Event Persistence / Retry & Cancellation        │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                    Agent Adapter Layer                      │
│ OpenCodeAdapter | CodexAdapter | ClaudeCodeAdapter           │
│ 能力检测 / 参数组装 / 协议转换 / 事件标准化 / 错误映射        │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                       Runner Layer                          │
│ 进程生命周期 / stdout-stderr / timeout / cancel / recovery  │
│ 工作目录校验 / 环境变量白名单 / 资源与并发限制                 │
└──────────────────────────────┬──────────────────────────────┘
                               │
             ┌─────────────────┼──────────────────┐
             ▼                 ▼                  ▼
         OpenCode            Codex           Claude Code
         HTTP / Session      CLI / App       CLI / Agent SDK
                             Server
             └─────────────────┼──────────────────┘
                               ▼
                 Git Worktree / Repository / Tests
```

### 3.1 对现有项目的建议映射

在现有仓库结构上增量增加模块，避免重写已有业务：

- `apps/server/src/opencode.ts`：继续保留，作为 OpenCode 集成的基础；后续将适合通用化的类型和能力提取到适配器接口。
- `apps/server/src/routes/`：增加 Agent provider、runtime、run 等 API 路由。
- `packages/core/src/types.ts`、`schemas.ts`：增加通用 Agent 类型、运行状态和输入校验 schema。
- `packages/core/src/db.ts`、`store.ts`、`transactions.ts`：按当前数据库迁移机制增加执行记录、事件记录等持久化结构。
- `apps/cli/`：如有必要，增加 Runner 诊断、Agent 检测或执行器管理命令。
- `apps/web/src/`：增加 Agent 选择、运行详情、实时日志、权限提示等界面。
- 建议新增 `apps/server/src/agents/`（或与项目现有目录规范一致的路径）存放接口、注册表和适配器；新增 `runner/` 模块管理进程生命周期。

以上为建议的代码归属，不代表这些模块已创建。实现前应先检查现有路由、存储、事件和进程管理代码，复用既有模式。

## 4. Agent 接入策略

### 4.1 OpenCode

第一阶段复用现有 OpenCode Server 集成：

- 通过配置的服务地址访问官方支持的 API。
- 支持发现会话、选择工作目录和发起任务。
- 明确区分创建新会话、向已有会话发送指令、查询会话状态。
- 对超时、断连、HTTP 错误和服务不可用统一映射为可读错误。
- 后续补齐事件订阅、取消、恢复等能力。

现有的 OpenCode 文件浏览和会话发现能力应尽量保留，避免重复实现。启动任务时必须确认会话实际目录与所选工作目录一致。

### 4.2 OpenAI Codex

建议分两步：

1. **MVP：本机 Codex CLI 执行。** 检测 CLI 是否安装及可用，使用受支持的命令行参数在指定 Worktree 中执行任务，读取结构化输出（如果当前版本支持）、标准输出/错误和退出码。
2. **增强：会话级通信。** 评估 Codex App Server 等官方支持的程序化接口，提供持续会话、状态订阅和更细粒度的控制。

CLI 一次性执行和连接已有交互会话属于不同能力，必须分别建模。参数、输出格式和会话功能应以实际安装版本的官方文档为准，不要假定不同版本行为完全一致。

### 4.3 Claude Code

建议分两步：

1. **MVP：Claude Code CLI。** 使用该版本官方支持的非交互/程序化执行模式，采集流式输出、最终结果和退出状态。
2. **增强：Agent SDK 或会话恢复。** 当需要更强的程序化控制时，再评估官方 SDK 与会话恢复能力。

认证、工具权限、审批提示、会话标识及输出协议应由 Claude Code 适配器单独处理。不得把 Claude Code 简化成 OpenCode 的 URL 配置，也不能假设其权限语义与其他 Agent 一致。

### 4.4 Provider、Runtime、Run 的区别

- **Provider**：Agent 产品类型，例如 `opencode`、`codex`、`claude-code`。
- **Runtime**：实际可执行实例，例如某台开发机上的 Codex CLI，或一个 OpenCode Server 地址。
- **Run**：针对某个 Task 发起的一次具体执行。

一个 Provider 可以对应多个 Runtime；一个 Task 可以对应多次 Run。不能将三者混为一个配置对象。

## 5. 统一领域模型

以下是逻辑模型，具体列类型、ID 格式、索引及迁移方式需遵循项目当前数据库约定。

### 5.1 AgentProvider

建议字段：

- `id`
- `type`：`opencode | codex | claude-code`
- `name`
- `enabled`
- `configJson`：非敏感配置
- `createdAt`、`updatedAt`

### 5.2 AgentRuntime

建议字段：

- `id`
- `providerId`
- `name`
- `kind`：`local-cli | http-server | sdk`
- `endpoint`：仅适用于服务类 Runtime
- `hostId`：为未来多机器 Runner 预留
- `healthStatus`、`lastHealthCheckAt`
- `version`
- `createdAt`、`updatedAt`

不要把 token、API Key 或完整环境变量保存在普通配置 JSON 中。敏感凭据应使用受控的本机凭据存储或部署环境 Secret。

### 5.3 AgentRun

建议字段：

- `id`
- `issueId`
- `providerId`、`runtimeId`
- `agentSessionId`：外部会话 ID，可为空
- `status`
- `prompt` 或任务输入快照
- `workspacePath`
- `worktreePath`、`branchName`
- `processId`：仅作为诊断信息，不能单独作为可靠的进程恢复机制
- `startedAt`、`finishedAt`
- `exitCode`
- `resultSummary`
- `errorCode`、`errorMessage`
- `createdAt`、`updatedAt`

### 5.4 AgentEvent

建议字段：

- `id`
- `runId`
- `sequence`：同一次 Run 内的递增序号
- `type`：`status | stdout | stderr | tool | approval | result | error | heartbeat`
- `payloadJson`
- `createdAt`

对大体积日志可采用分块或文件存储，数据库保留索引与必要摘要。日志需设置保留期限、敏感信息脱敏策略和访问控制。

### 5.5 AgentSession

建议字段：

- `id`
- `providerId`、`runtimeId`
- `providerSessionId`
- `workspacePath`
- `createdAt`、`lastUsedAt`

外部会话 ID 不能作为跨 Agent 的统一 ID；应使用 Taskboard 自己的 ID 关联，并保留 provider 原始标识。

## 6. 适配器接口

以下为设计示意，应结合当前 TypeScript 版本和代码规范落地：

```ts
type AgentProviderType = 'opencode' | 'codex' | 'claude-code';

type AgentCapability =
  | 'start-run'
  | 'stream-events'
  | 'cancel-run'
  | 'send-message'
  | 'resume-session'
  | 'approval-events'
  | 'structured-output';

interface AgentHealth {
  available: boolean;
  version?: string;
  capabilities: AgentCapability[];
  reason?: string;
}

interface AgentRunInput {
  runId: string;
  prompt: string;
  workspacePath: string;
  sessionId?: string;
  timeoutMs?: number;
  approvalPolicy: 'require-approval' | 'provider-default';
}

interface AgentRunHandle {
  runId: string;
  providerSessionId?: string;
  processId?: number;
}

interface AgentEvent {
  runId: string;
  sequence?: number;
  type: 'status' | 'stdout' | 'stderr' | 'tool' | 'approval'
    | 'result' | 'error' | 'heartbeat';
  timestamp: string;
  payload: unknown;
}

interface AgentAdapter {
  readonly provider: AgentProviderType;

  detect(runtimeId: string): Promise<AgentHealth>;

  start(input: AgentRunInput): Promise<AgentRunHandle>;

  stream(runId: string): AsyncIterable<AgentEvent>;

  getStatus(runId: string): Promise<{
    status: string;
    exitCode?: number;
  }>;

  cancel(runId: string): Promise<void>;

  sendMessage?(sessionId: string, message: string): Promise<void>;

  resumeSession?(sessionId: string): Promise<AgentRunHandle>;
}
```

### 6.1 能力协商

适配器必须返回实际支持的能力。UI 根据能力显示按钮：

- 不支持 `send-message`：不显示“向当前会话发送消息”。
- 不支持 `resume-session`：不显示“恢复会话”。
- 不支持 `approval-events`：展示该 Agent 自身的权限/审批提示，不伪造 Taskboard 审批闭环。
- 不支持可靠取消：必须说明取消限制，并尽可能通过 Runner 管理进程退出。

通用接口负责稳定性，Provider 扩展字段负责表达产品差异。

## 7. 执行生命周期与状态机

建议的标准状态：

- `queued`：等待执行。
- `starting`：正在检查环境、准备工作目录或启动进程。
- `running`：执行中。
- `awaiting_approval`：等待用户或 Provider 授权。
- `succeeded`：成功完成。
- `failed`：执行失败。
- `cancelled`：已取消。
- `interrupted`：进程或 Runner 意外中断，状态尚待恢复/确认。

主要流程：

1. 验证任务、Provider、Runtime 和用户权限。
2. 检查 Agent 是否安装、可用及已完成认证。
3. 验证项目路径；按策略创建或校验 Worktree。
4. 创建 `AgentRun` 并持久化 `queued/starting` 状态。
5. 启动 Agent，并记录运行句柄与外部会话 ID。
6. 标准化并持久化事件，推送到前端。
7. 处理退出码、最终结果和状态迁移。
8. 更新 Taskboard 任务状态；必要时触发测试或人工 Review。
9. 清理临时资源，但默认保留失败任务的 Worktree 供排障。

状态迁移必须校验合法性，并防止重复提交导致同一个 Run 被启动多次。任务创建 API 应支持幂等键或其他防重复机制。

## 8. Runner 与工作目录隔离

### 8.1 MVP Runner

第一阶段建议 Runner 与 Taskboard Server 部署在同一台开发机上，优先适配当前 Windows 开发环境。后续再抽象 Runner 注册协议。

Runner 负责：

- 启动和监督子进程。
- 受控传递参数与环境变量。
- 收集 stdout、stderr、结构化事件。
- 管理超时、取消、退出码和子进程清理。
- 校验工作目录必须位于用户授权的项目根目录内。
- 记录运行元数据，处理 Server 重启后的恢复或中断标记。

不要依赖仅保存 PID 来恢复任务：进程可能已退出、PID 可能被重用。需要为每个执行实例保存可验证的进程信息，并在启动时使用唯一 Run ID 关联日志和状态。

### 8.2 Worktree 策略

- 默认每次 Run 使用独立 Git Worktree 和专属分支。
- 任务重试时，明确选择新建 Worktree 或复用原 Worktree。
- 同一 Worktree 不允许多个 Agent 并发写入，除非用户显式选择并理解风险。
- 保留任务与 Worktree 的绑定关系，支持完成后查看 diff。
- 自动删除 Worktree 前检查未提交改动，避免数据丢失。
- 将目录路径规范化，并处理 Windows 路径大小写、盘符和分隔符差异。

## 9. API 设计建议

实际路径应服从现有 API 命名规范。建议提供以下接口：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/agent-providers` | 查询可用 Provider 与能力 |
| GET | `/api/agent-runtimes` | 查询配置的运行实例 |
| POST | `/api/agent-runtimes/:id/health-check` | 检测安装、版本、认证和服务可用性 |
| GET | `/api/issues/:id/agent-runs` | 查询任务执行历史 |
| POST | `/api/issues/:id/agent-runs` | 为任务创建并启动一次执行 |
| GET | `/api/agent-runs/:runId` | 获取执行详情 |
| POST | `/api/agent-runs/:runId/cancel` | 取消执行 |
| GET | `/api/agent-runs/:runId/events` | 查询事件历史 |
| GET | `/api/agent-runs/:runId/stream` | 通过 SSE 接收实时事件 |
| POST | `/api/agent-runs/:runId/messages` | 向支持交互的会话发送消息 |
| POST | `/api/agent-runs/:runId/resume` | 恢复支持恢复的会话 |

注意事项：

- 创建执行应返回 `runId`，不应等待整个 Agent 任务执行完毕。
- SSE 断线后支持按 sequence 或游标补拉事件，不能只依赖内存中的实时广播。
- 对需要较长时间的任务，采用持久化 Job/Run 模式，不要占用单个 API 请求直到结束。
- 错误响应采用稳定错误码，避免把底层密钥、环境变量或敏感命令暴露给前端。
- 写操作必须验证项目访问权限、路径权限和运行权限。

## 10. Web 交互设计

### 10.1 Agent 管理

显示每个 Runtime 的：

- Agent 名称、类型、版本。
- 连接/安装状态与最近健康检查时间。
- 工作目录或服务地址。
- 支持的能力。
- 配置与认证问题提示。

“已配置”与“当前可用”必须是不同状态。

### 10.2 启动任务

从看板任务详情启动：

1. 选择 Agent Provider。
2. 选择具体 Runtime（如果存在多个）。
3. 选择新建会话或使用可用的既有会话（仅对支持的 Agent 显示）。
4. 确认工作目录及 Worktree 策略。
5. 输入任务提示词或使用任务描述自动生成初始提示词。
6. 显示权限策略、超时和并发限制。
7. 启动后跳转到 Run 详情页。

### 10.3 Run 详情

至少包含：

- 当前状态、运行时长、Agent 版本和工作目录。
- 实时 stdout/stderr 与标准化事件时间线。
- 取消、重试、恢复（仅限支持的 Agent）操作。
- Git 分支、Worktree 路径、变更文件和 diff 入口。
- 最终结果摘要、退出码、失败原因。
- 测试结果、Review 状态及人工审批记录。

不要把三种 Agent 的内部对话格式强行渲染成完全相同的聊天 UI。MVP 以统一时间线和日志为主，后续再为各 Provider 增加专属事件视图。

## 11. 安全、权限与可靠性

### 11.1 命令执行安全

- 禁止将用户输入拼接到 Shell 字符串中执行；优先使用固定可执行文件路径和参数数组。
- 仅允许选择已注册的 Agent Provider/Runtime，不接受任意可执行文件路径作为普通用户输入。
- 对工作目录做规范化与授权根目录校验，防止路径穿越。
- 限制环境变量白名单，避免将服务器 Secret 传给 Agent 子进程。
- 对命令执行、文件修改、网络访问等能力遵守 Provider 的权限策略。
- 对危险操作使用显式审批，不允许通过 Taskboard 自动绕过 Provider 自身的安全机制。

### 11.2 网络与认证

- OpenCode Server 地址应做 URL 校验、超时控制、重定向策略和 SSRF 防护。
- 远程访问 Taskboard 时需要认证和授权；不要将无认证的 Runner 控制接口暴露到公网。
- API Key、OAuth token、CLI 凭据不得写入数据库普通字段、日志、任务提示词或前端状态。
- 诊断日志应脱敏，避免记录完整环境变量和敏感请求头。

### 11.3 并发与故障处理

- 设置全局、Runtime 级别和项目级并发上限。
- 设置任务超时、心跳、取消宽限期和资源清理策略。
- 防止同一个 Run 重复启动；重试创建新 Run，并关联原 Run。
- Server 重启后扫描未终结记录，验证实际进程状态，不能确认时标记为 `interrupted`。
- 进程被强制终止时，确保子进程和相关资源能被回收。
- 日志采用分页或分块读取，并限制单次响应大小。

## 12. 测试策略

### 12.1 单元测试

- Provider 注册、能力声明与状态映射。
- 参数组装、路径规范化、工作目录校验。
- 标准输出解析、事件转换、错误映射。
- 状态机合法迁移、重复启动保护、幂等逻辑。
- 取消、超时、退出码及异常中断处理。

### 12.2 集成测试

- 用假 Agent 可执行程序验证 Runner 启动、流式日志、退出码、取消和超时。
- 对 OpenCode API 使用 Mock Server 覆盖成功、HTTP 错误、超时和会话目录不匹配。
- 对 Codex 和 Claude Code 适配器使用可替换的进程执行层，不要求每次 CI 都依赖真实账号或在线模型。
- 数据库迁移测试覆盖旧数据库升级和新库初始化。
- SSE 断连重连后可以补齐事件，不重复或遗漏关键状态。

### 12.3 端到端验收

对每个 Agent 分别验证：

1. Agent 缺失或未认证时能显示明确错误。
2. 能在独立 Worktree 启动一个简单任务。
3. UI 能收到运行状态和连续日志。
4. 成功、失败、取消、超时均能正确结束。
5. 刷新页面后仍能看到执行记录。
6. Server 重启后能恢复状态或准确标记中断。
7. 能查看本次执行的 Git diff。
8. 一个 Agent 的异常不会破坏其他 Provider 的执行。

## 13. 分阶段实施计划

### Phase 0：现状盘点与协议验证

- 检查现有 OpenCode 路由、Session、Run/Task 类型、数据库迁移、事件推送和 Worktree 逻辑。
- 确认当前运行环境：Windows 本机、服务器或容器；确定 Agent CLI 的安装位置和认证方式。
- 针对安装版本验证 Codex CLI、Claude Code CLI 的调用参数、输出格式、取消方式及会话能力。
- 产出接口差异表和具体迁移清单。

**退出条件：** 三种 Agent 的 MVP 执行路径已在目标环境中通过最小实验，且认证、权限和输出协议已确认。

### Phase 1：统一执行 MVP

- 新增 Provider/Runtime/Run/Event 类型及数据库迁移。
- 定义适配器接口与注册表。
- 复用并适配现有 OpenCode 能力。
- 新增 Codex CLI 和 Claude Code CLI 适配器。
- 实现 Runner、日志事件、取消、超时和状态持久化。
- Web 增加 Agent 选择和 Run 详情页。
- 建立 Mock/假 Agent 测试，避免 CI 依赖真实模型服务。

**退出条件：** 三种 Agent 均能在同一面板启动、观察、取消和追踪执行。

### Phase 2：会话与可靠性

- 评估并接入各 Provider 的会话恢复/持续通信机制。
- 增加健康检查、版本检测、认证诊断。
- 补齐断线重连、Server 重启恢复、幂等启动和清理策略。
- 增加事件补拉、日志分页和运行历史。

**退出条件：** 支持的会话可以继续交互；不支持的能力在 UI 中明确禁用，而不是返回模糊错误。

### Phase 3：协作工作流

- 一个任务可串行或并行触发多个 Run。
- 增加 Reviewer Agent、测试阶段和人工审批节点。
- 统一结果摘要、diff、测试结果和 Review 记录。
- 为多机器 Runner 设计注册、心跳和调度协议。

**退出条件：** 工作流每一步可追溯、可中断、可恢复，且合并始终受项目策略与人工授权约束。

## 14. 主要风险与决策

| 风险/决策 | 建议 |
|---|---|
| Agent 原生能力不一致 | 以能力协商为准，不强求完全对称 |
| CLI 参数随版本变化 | 启动时检测版本，适配器有明确的版本兼容策略 |
| 多 Agent 竞争写代码 | 默认独立 Worktree |
| 长任务期间服务重启 | Run/Event 持久化，Runner 负责恢复或标记中断 |
| CI 无法使用真实模型账号 | 用 Fake Agent 和 Mock Server 做确定性测试，真实端到端测试单独执行 |
| 任务提示词和日志含敏感数据 | 最小化存储、脱敏、权限控制和保留期限 |
| 远程 Runner 复杂度过高 | 先做本机 Runner，后续再扩展多机器 |
| 自动 Review 误合并 | Review 与 Merge 分离，默认人工确认 |

## 15. 建议的首批交付清单

- [ ] 完成现有架构盘点和三种 Agent 的协议验证。
- [ ] 确定 Provider、Runtime、Run、Session、Event 的领域模型。
- [ ] 增加数据库迁移和核心 schema。
- [ ] 定义 AgentAdapter 接口、能力模型和错误码。
- [ ] 实现统一 Runner 与假 Agent 测试程序。
- [ ] 将现有 OpenCode 能力接入统一执行层。
- [ ] 实现 Codex CLI 适配器。
- [ ] 实现 Claude Code CLI 适配器。
- [ ] 增加 Run 启动、查询、取消和事件接口。
- [ ] 增加 Web Agent 选择、实时日志与执行详情。
- [ ] 完成超时、取消、断线、重启和路径权限测试。
- [ ] 完成三种 Agent 的真实环境验收。
- [ ] 再启动会话恢复与多 Agent 工作流阶段。

## 16. 结论

采用“统一任务管理层 + Agent Adapter + Runner + Worktree”的架构，可以在一个 Taskboard 面板中逐步接入 OpenCode、Codex 和 Claude Code，同时保留各自原生能力。

实施顺序应为：

1. 先统一启动、日志、状态、取消和结果。
2. 再分别实现会话恢复与持续交互。
3. 最后实现多 Agent 编排、自动 Review 和流水线。

第一阶段的成功标准不是 UI 中出现三个 Agent 选项，而是三种 Agent 都能在明确的工作目录内可靠执行任务，并且运行状态、日志、取消、失败恢复与代码改动可追溯。
