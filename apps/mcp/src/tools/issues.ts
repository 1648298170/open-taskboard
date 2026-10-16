// Issue tools: list_issues / show_issue / create_issue / update_issue /
// delete_issue / archive_issue / unarchive_issue / add_comment / progress +
// dependencies (add/remove), the smart pickup views (ready_issues /
// next_issue) and full-text search (search_issues). create/update/comment
// schemas come from @taskboard/core (update_issue uses mcpUpdateIssueSchema:
// version REQUIRED); the rest are small local zod schemas with STATUSES
// imported from core/types — no hardcoded enum literals, no hand-written
// JSON Schema.
import {
  z, createIssueSchema, mcpUpdateIssueSchema, addCommentSchema, addDependencySchema
} from '@taskboard/core/schemas';
import { STATUSES } from '@taskboard/core/types';
import { ensureServerOrThrow } from '../connection.js';
import { defineTool, type ToolTable } from './registry.js';

const idSchema = z.object({ id: z.string() }).strict();

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
      return ensureServerOrThrow('GET', `/api/projects/${args.projectId}/issues?${qs}`);
    },
  )],
  ['show_issue', defineTool(
    idSchema,
    '查看任务详情：描述、子任务、评论、版本号',
    async args => {
      const detail = (await ensureServerOrThrow('GET', `/api/issues/${args.id}`)) as IssueDetail;
      // Strip activities (token economy) — consistent with child-description stripping.
      const { activities: _activities, ...issue } = detail;
      return { ...issue, children: issue.children?.map(({ description: _d, ...c }) => c) };
    },
  )],
  ['create_issue', defineTool(
    createIssueSchema,
    '创建任务。拆解需求时：先建顶层父任务，再用 parentId 为每个子需求建子任务（仅支持两层）',
    args => ensureServerOrThrow('POST', `/api/projects/${args.projectId}/issues`, {
      parentId: args.parentId ?? null, title: args.title, description: args.description ?? '',
      status: args.status ?? 'todo', priority: args.priority ?? 'medium',
      labels: args.labels ?? '', branch: args.branch ?? '', assignee: args.assignee ?? '',
      worktree: args.worktree ?? null,
      startDate: args.startDate ?? null, dueDate: args.dueDate ?? null,
    }),
  )],
  ['update_issue', defineTool(
    mcpUpdateIssueSchema.extend({ id: z.string() }),
    '更新任务。状态流转 todo → in_progress → in_review → done；done 需用户确认后才能设置。必须带 version（乐观锁，取自 show_issue），冲突时重新读取再试',
    args => {
      const body: Record<string, unknown> = { version: args.version };
      for (const k of ['title', 'description', 'status', 'priority', 'labels', 'branch', 'worktree', 'assignee', 'parentId', 'startDate', 'dueDate'] as const) {
        const v = args[k];
        if (v !== undefined) body[k] = v;
      }
      return ensureServerOrThrow('PATCH', `/api/issues/${args.id}`, body);
    },
  )],
  ['delete_issue', defineTool(
    idSchema,
    '删除任务（级联删除其子任务与评论）',
    args => ensureServerOrThrow('DELETE', `/api/issues/${args.id}`),
  )],
  ['archive_issue', defineTool(
    idSchema,
    '归档任务（从看板/就绪列表/进度统计中移除；list_issues 带 archived=only 可查看，unarchive_issue 可恢复）',
    args => ensureServerOrThrow('POST', `/api/issues/${args.id}/archive`, {}),
  )],
  ['unarchive_issue', defineTool(
    idSchema,
    '取消归档任务（恢复到看板）',
    args => ensureServerOrThrow('POST', `/api/issues/${args.id}/unarchive`, {}),
  )],
  ['search_issues', defineTool(
    z.object({ query: z.string().min(1) }).strict(),
    '全文搜索任务：标题/描述/评论（trigram，≥3 字符）；更短的查询退化为标题/描述的 LIKE 扫描',
    args => ensureServerOrThrow('GET', `/api/search?q=${encodeURIComponent(args.query)}`),
  )],
  ['add_comment', defineTool(
    addCommentSchema.extend({ id: z.string() }),
    '添加评论，用于记录进展、阻塞、验证方式',
    args => ensureServerOrThrow('POST', `/api/issues/${args.id}/comments`, {
      author: args.author ?? 'mcp', body: args.body,
    }),
  )],
  ['add_issue_dependency', defineTool(
    addDependencySchema.extend({ id: z.string() }),
    '添加依赖：id 任务被 dependsOnId 阻塞（dependsOnId 完成前 id 不算就绪）。禁止自依赖/跨项目/循环依赖',
    args => ensureServerOrThrow('POST', `/api/issues/${args.id}/dependencies`, {
      dependsOnId: args.dependsOnId,
    }),
  )],
  ['remove_issue_dependency', defineTool(
    z.object({ id: z.string(), dependsOnId: z.string().min(1) }).strict(),
    '移除依赖：解除 id 对 dependsOnId 的阻塞关系',
    args => ensureServerOrThrow('DELETE', `/api/issues/${args.id}/dependencies/${args.dependsOnId}`),
  )],
  ['ready_issues', defineTool(
    z.object({
      projectId: z.string(),
      assignee: z.string().optional().describe('只看分配给该负责人的就绪任务'),
    }).strict(),
    '列出项目下就绪的任务：自身未 done 且所有依赖（blocked-by）均已 done，按优先级排序',
    args => {
      const qs = new URLSearchParams();
      if (args.assignee !== undefined) qs.set('assignee', args.assignee);
      return ensureServerOrThrow('GET', `/api/projects/${args.projectId}/ready?${qs}`);
    },
  )],
  ['next_issue', defineTool(
    z.object({
      projectId: z.string(),
      assignee: z.string().optional().describe('只在该负责人的就绪任务中挑选'),
    }).strict(),
    '智能领任务：返回项目下一个最该做的任务（就绪列表的第一个，依赖全 done + 优先级排序），无就绪任务时 issue 为 null',
    args => {
      const qs = new URLSearchParams();
      if (args.assignee !== undefined) qs.set('assignee', args.assignee);
      return ensureServerOrThrow('GET', `/api/projects/${args.projectId}/next?${qs}`);
    },
  )],
  ['progress', defineTool(
    z.object({ projectId: z.string() }).strict(),
    '项目进度。weighted 口径：一个顶层任务 = 一个单位，自身 done 或子任务全 done 即完成',
    args => ensureServerOrThrow('GET', `/api/projects/${args.projectId}/progress`),
  )],
];
