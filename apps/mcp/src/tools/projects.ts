// Project tools: list_projects / create_project / update_project / delete_project.
// Schemas derive from @taskboard/core (single source of truth); the few shapes
// core does not model are small local zod schemas, JSON-generated the same way.
import { z, createProjectSchema } from '@taskboard/core/schemas';
import { ensureServerOrThrow } from '../connection.js';
import { rememberSession } from '../session.js';
import { defineTool, type ToolTable } from './registry.js';

export const projectTools: ToolTable = [
  ['list_projects', defineTool(
    z.object({}).strict(),
    '列出任务板上所有项目',
    () => ensureServerOrThrow('GET', '/api/projects'),
  )],
  ['create_project', defineTool(
    createProjectSchema,
    '创建项目',
    args => {
      if (args.sessionId) rememberSession(args.sessionId);
      return ensureServerOrThrow('POST', '/api/projects', {
        id: args.id, name: args.name, workspacePath: args.workspacePath ?? '', ...(args.wakeChannel ? { wakeChannel: args.wakeChannel } : {}), ...(args.labels ? { labels: args.labels } : {}), ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
      });
    },
  )],
  ['update_project', defineTool(
    z.object({
      id: z.string(),
      name: z.string().min(1).optional(),
      wakeChannel: z.string().optional(),
      labels: z.string().optional(),
      // '' clears the project default session; whitespace-only is rejected.
      sessionId: z.union([z.string().trim().min(1).max(200), z.literal('')]).optional(),
    }).strict(),
    '更新项目名称和/或唤醒通道绑定/标签/默认会话（wakeChannel 传空串清除绑定；sessionId 传空串清除默认会话；labels 逗号分隔）',
    args => {
      if (args.sessionId) rememberSession(args.sessionId);
      return ensureServerOrThrow('PATCH', `/api/projects/${args.id}`, {
        ...(args.name ? { name: args.name } : {}), ...(args.wakeChannel !== undefined ? { wakeChannel: args.wakeChannel } : {}), ...(args.labels !== undefined ? { labels: args.labels } : {}), ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
      });
    },
  )],
  ['project_git_refs', defineTool(
    z.object({ projectId: z.string() }).strict(),
    '扫描项目工作区的 git 分支与 worktree 列表（workspacePath 为空或非 git 仓库时返回空列表），用于绑定任务的 branch/worktree',
    args => ensureServerOrThrow('GET', `/api/projects/${args.projectId}/git-refs`),
  )],
  ['delete_project', defineTool(
    z.object({ id: z.string() }).strict(),
    '删除项目及其全部任务与评论（危险操作）',
    args => ensureServerOrThrow('DELETE', `/api/projects/${args.id}`),
  )],
];
