// Issue tools: list_issues / show_issue / create_issue / update_issue /
// delete_issue / archive_issue / unarchive_issue / claim_issue /
// heartbeat_issue / release_issue / add_comment / progress +
// dependencies (add/remove), the smart pickup views (ready_issues /
// next_issue) and full-text search (search_issues). create/update/comment/
// claim schemas come from @taskboard/core (update_issue uses
// mcpUpdateIssueSchema: version REQUIRED); the rest are small local zod
// schemas with STATUSES imported from core/types — no hardcoded enum
// literals, no hand-written JSON Schema.
import {
  z, createIssueSchema, mcpUpdateIssueSchema, addCommentSchema, addDependencySchema, claimSchema
} from '@taskboard/core/schemas';
import { STATUSES } from '@taskboard/core/types';
import { ensureServerOrThrow } from '../connection.js';
import { defineTool, type ToolTable } from './registry.js';

const idSchema = z.object({ id: z.string() }).strict();

// Path segments come from LLM-authored tool arguments — never trust them raw
// in URLs (a '/' or '?' would rewrite the route).
const seg = (value: string): string => encodeURIComponent(value);

interface IssueDetail { children?: { description: string }[]; activities?: unknown[] }

export const issueTools: ToolTable = [
  ['list_issues', defineTool(
    z.object({
      projectId: z.string(),
      status: z.enum(STATUSES).optional(),
      parentId: z.string().nullable().optional().describe('只看某父任务的子任务；null 表示只看顶层'),
      archived: z.enum(['only', 'all']).optional().describe('T5-24：默认排除已归档任务；only 只看已归档，all 全部'),
    }).strict(),
    '列出项目下的任务（含子任务；默认不含已归档）',
    args => {
      const qs = new URLSearchParams();
      if (args.status) qs.set('status', args.status);
      if (args.parentId !== undefined) qs.set('parentId', args.parentId ?? 'null');
      if (args.archived !== undefined) qs.set('archived', args.archived);
      return ensureServerOrThrow('GET', `/api/projects/${seg(args.projectId)}/issues?${qs}`);
    },
  )],
  ['show_issue', defineTool(
    idSchema,
    '查看任务详情：描述、子任务、评论、版本号',
    async args => {
      const detail = (await ensureServerOrThrow('GET', `/api/issues/${seg(args.id)}`)) as IssueDetail;
      // Strip activities (token economy) — consistent with child-description stripping.
      const { activities: _activities, ...issue } = detail;
      return { ...issue, children: issue.children?.map(({ description: _d, ...c }) => c) };
    },
  )],
  ['create_issue', defineTool(
    createIssueSchema,
    '创建任务。拆解需求时：先建顶层父任务，再用 parentId 为每个子需求建子任务（仅支持两层）。TASKBOARD_HUMAN_DONE=1 时创建即 done 与 PATCH 置 done 同责：非 web 来源需用户确认后传 confirm: true',
    args => ensureServerOrThrow('POST', `/api/projects/${seg(args.projectId)}/issues`, {
      parentId: args.parentId ?? null, title: args.title, description: args.description ?? '',
      status: args.status ?? 'todo', priority: args.priority ?? 'medium',
      labels: args.labels ?? '', branch: args.branch ?? '', assignee: args.assignee ?? '',
      worktree: args.worktree ?? null,
      startDate: args.startDate ?? null, dueDate: args.dueDate ?? null,
      ...(args.confirm !== undefined ? { confirm: args.confirm } : {}),
    }),
  )],
  ['update_issue', defineTool(
    mcpUpdateIssueSchema.extend({ id: z.string() }),
    '更新任务。状态流转 todo → in_progress → in_review → done；done 需用户确认后才能设置。必须带 version（乐观锁，取自 show_issue），冲突时重新读取再试',
    args => {
      const body: Record<string, unknown> = { version: args.version };
      for (const k of ['title', 'description', 'status', 'priority', 'labels', 'branch', 'worktree', 'assignee', 'parentId', 'startDate', 'dueDate', 'confirm'] as const) {
        const v = args[k];
        if (v !== undefined) body[k] = v;
      }
      return ensureServerOrThrow('PATCH', `/api/issues/${seg(args.id)}`, body);
    },
  )],
  ['delete_issue', defineTool(
    idSchema,
    '删除任务（级联删除其子任务与评论）',
    args => ensureServerOrThrow('DELETE', `/api/issues/${seg(args.id)}`),
  )],
  ['archive_issue', defineTool(
    idSchema,
    '归档任务（连带归档其未归档子任务；从看板/就绪列表/进度统计中移除。list_issues 带 archived=only 可查看，unarchive_issue 恢复父任务本身）',
    args => ensureServerOrThrow('POST', `/api/issues/${seg(args.id)}/archive`, {}),
  )],
  ['unarchive_issue', defineTool(
    idSchema,
    '取消归档任务（恢复父任务本身到看板；子任务保持归档，需逐个 unarchive）',
    args => ensureServerOrThrow('POST', `/api/issues/${seg(args.id)}/unarchive`, {}),
  )],
  // T7-34: 独占租约三件套。租约默认 30 分钟，过期后其他 agent 可直接
  // 认领（惰性过期，无需定时器）。
  ['claim_issue', defineTool(
    claimSchema.extend({ id: z.string() }),
    '认领任务（独占租约）：租约期内其他 agent 认领会 409。建议先 claim 再开工，长任务用心跳续租，完成后 release。ttlMinutes 默认 30，上限 1440',
    args => ensureServerOrThrow('POST', `/api/issues/${seg(args.id)}/claim`, {
      agent: args.agent,
      ...(args.ttlMinutes !== undefined ? { ttlMinutes: args.ttlMinutes } : {}),
    }),
  )],
  ['heartbeat_issue', defineTool(
    claimSchema.omit({ ttlMinutes: true }).extend({ id: z.string() }),
    '心跳续租：延长自己持有任务的租约到期时间（长任务定期调用防过期；非持有人或租约已过期会 409）',
    args => ensureServerOrThrow('POST', `/api/issues/${seg(args.id)}/heartbeat`, { agent: args.agent }),
  )],
  ['release_issue', defineTool(
    claimSchema.omit({ ttlMinutes: true }).extend({ id: z.string() }),
    '释放任务租约（完成或放弃时调用；释放未认领/已过期的任务是幂等 no-op）',
    args => ensureServerOrThrow('POST', `/api/issues/${seg(args.id)}/release`, { agent: args.agent }),
  )],
  ['search_issues', defineTool(
    z.object({ query: z.string().min(1) }).strict(),
    '全文搜索任务：标题/描述/评论（trigram，≥3 字符）；更短的查询退化为标题/描述的 LIKE 扫描',
    args => ensureServerOrThrow('GET', `/api/search?q=${encodeURIComponent(args.query)}`),
  )],
  ['add_comment', defineTool(
    addCommentSchema.extend({ id: z.string() }),
    '添加评论，用于记录进展、阻塞、验证方式',
    args => ensureServerOrThrow('POST', `/api/issues/${seg(args.id)}/comments`, {
      author: args.author ?? 'mcp', body: args.body,
    }),
  )],
  ['delete_comment', defineTool(
    idSchema,
    '删除评论（id 为评论 id，非任务 id；级联清理全文索引并留活动痕）',
    args => ensureServerOrThrow('DELETE', `/api/comments/${seg(args.id)}`),
  )],
  // T7-39: 附件只读视图 —— 上传走 Web/CLI（multipart 不适合 MCP stdio），MCP 提供列表。
  ['list_attachments', defineTool(
    idSchema,
    '列出任务附件（id/文件名/大小/上传者/时间）。附件经 Web 或 CLI (`taskboard issue attach`) 上传，MCP 仅提供列表，不含上传；下载路径为 /api/attachments/<id>/download',
    args => ensureServerOrThrow('GET', `/api/issues/${seg(args.id)}/attachments`),
  )],
  ['add_issue_dependency', defineTool(
    addDependencySchema.extend({ id: z.string() }),
    '添加依赖：id 任务被 dependsOnId 阻塞（dependsOnId 完成前 id 不算就绪）。禁止自依赖/跨项目/循环依赖',
    args => ensureServerOrThrow('POST', `/api/issues/${seg(args.id)}/dependencies`, {
      dependsOnId: args.dependsOnId,
    }),
  )],
  ['remove_issue_dependency', defineTool(
    z.object({ id: z.string(), dependsOnId: z.string().min(1) }).strict(),
    '移除依赖：解除 id 对 dependsOnId 的阻塞关系',
    args => ensureServerOrThrow('DELETE', `/api/issues/${seg(args.id)}/dependencies/${seg(args.dependsOnId)}`),
  )],
  ['ready_issues', defineTool(
    z.object({
      projectId: z.string(),
      assignee: z.string().optional().describe('只看分配给该负责人的就绪任务'),
      agent: z.string().optional().describe('以该 agent 视角过滤：排除已被其他 agent 有效认领（租约未过期）的任务'),
    }).strict(),
    '列出项目下就绪的任务：自身未 done 且所有依赖（blocked-by）均已 done，按优先级排序',
    args => {
      const qs = new URLSearchParams();
      if (args.assignee !== undefined) qs.set('assignee', args.assignee);
      if (args.agent !== undefined) qs.set('agent', args.agent);
      return ensureServerOrThrow('GET', `/api/projects/${seg(args.projectId)}/ready?${qs}`);
    },
  )],
  ['next_issue', defineTool(
    z.object({
      projectId: z.string(),
      assignee: z.string().optional().describe('只在该负责人的就绪任务中挑选'),
      agent: z.string().optional().describe('以该 agent 视角挑选：排除已被其他 agent 有效认领（租约未过期）的任务'),
    }).strict(),
    '智能领任务：返回项目下一个最该做的任务（就绪列表的第一个，依赖全 done + 优先级排序），无就绪任务时 issue 为 null。建议先 claim 再开工，长任务用心跳续租',
    args => {
      const qs = new URLSearchParams();
      if (args.assignee !== undefined) qs.set('assignee', args.assignee);
      if (args.agent !== undefined) qs.set('agent', args.agent);
      return ensureServerOrThrow('GET', `/api/projects/${seg(args.projectId)}/next?${qs}`);
    },
  )],
  ['progress', defineTool(
    z.object({ projectId: z.string() }).strict(),
    '项目进度。weighted 口径：一个顶层任务 = 一个单位，自身 done 或子任务全 done 即完成',
    args => ensureServerOrThrow('GET', `/api/projects/${seg(args.projectId)}/progress`),
  )],
  ['project_stats', defineTool(
    z.object({
      projectId: z.string(),
      weeks: z.number().int().min(1).max(26).optional().describe('统计周数，默认 8'),
    }).strict(),
    '项目统计面板：近 N 周完成吞吐（周一起算）、平均周期（小时，按 updatedAt 估算）、Agent 贡献 top10、四状态分布',
    args => ensureServerOrThrow(
      'GET',
      `/api/projects/${seg(args.projectId)}/stats${args.weeks !== undefined ? `?weeks=${args.weeks}` : ''}`,
    ),
  )],
];
