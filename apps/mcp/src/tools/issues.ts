// Issue tools: list_issues / show_issue / create_issue / update_issue /
// delete_issue / add_comment / progress. create/update/comment schemas come
// from @taskboard/core (update_issue uses mcpUpdateIssueSchema: version
// REQUIRED); the rest are small local zod schemas with STATUSES imported from
// core/types — no hardcoded enum literals, no hand-written JSON Schema.
import { z, createIssueSchema, mcpUpdateIssueSchema, addCommentSchema } from '@taskboard/core/schemas';
import { STATUSES } from '@taskboard/core/types';
import { ensureServerOrThrow } from '../connection.js';
import { defineTool, type ToolTable } from './registry.js';

const idSchema = z.object({ id: z.string() }).strict();

interface IssueDetail { children?: { description: string }[] }

export const issueTools: ToolTable = [
  ['list_issues', defineTool(
    z.object({
      projectId: z.string(),
      status: z.enum(STATUSES).optional(),
      parentId: z.string().nullable().optional().describe('只看某父任务的子任务；null 表示只看顶层'),
    }).strict(),
    '列出项目下的任务（含子任务）',
    args => {
      const qs = new URLSearchParams();
      if (args.status) qs.set('status', args.status);
      if (args.parentId !== undefined) qs.set('parentId', args.parentId ?? 'null');
      return ensureServerOrThrow('GET', `/api/projects/${args.projectId}/issues?${qs}`);
    },
  )],
  ['show_issue', defineTool(
    idSchema,
    '查看任务详情：描述、子任务、评论、版本号',
    async args => {
      const i = (await ensureServerOrThrow('GET', `/api/issues/${args.id}`)) as IssueDetail;
      return { ...i, children: i.children?.map(({ description: _d, ...c }) => c) };
    },
  )],
  ['create_issue', defineTool(
    createIssueSchema,
    '创建任务。拆解需求时：先建顶层父任务，再用 parentId 为每个子需求建子任务（仅支持两层）',
    args => ensureServerOrThrow('POST', `/api/projects/${args.projectId}/issues`, {
      parentId: args.parentId ?? null, title: args.title, description: args.description ?? '',
      status: args.status ?? 'todo', priority: args.priority ?? 'medium',
      labels: args.labels ?? '', branch: args.branch ?? '', assignee: args.assignee ?? '',
    }),
  )],
  ['update_issue', defineTool(
    mcpUpdateIssueSchema.extend({ id: z.string() }),
    '更新任务。状态流转 todo → in_progress → in_review → done；done 需用户确认后才能设置。必须带 version（乐观锁，取自 show_issue），冲突时重新读取再试',
    args => {
      const body: Record<string, unknown> = { version: args.version };
      for (const k of ['title', 'description', 'status', 'priority', 'labels', 'branch', 'assignee', 'parentId'] as const) {
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
  ['add_comment', defineTool(
    addCommentSchema.extend({ id: z.string() }),
    '添加评论，用于记录进展、阻塞、验证方式',
    args => ensureServerOrThrow('POST', `/api/issues/${args.id}/comments`, {
      author: args.author ?? 'mcp', body: args.body,
    }),
  )],
  ['progress', defineTool(
    z.object({ projectId: z.string() }).strict(),
    '项目进度。weighted 口径：一个顶层任务 = 一个单位，自身 done 或子任务全 done 即完成',
    args => ensureServerOrThrow('GET', `/api/projects/${args.projectId}/progress`),
  )],
];
