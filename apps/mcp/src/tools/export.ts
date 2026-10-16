// T4-22: export_board — serialize the board (or one project) into a JSON or
// Markdown STRING, assembled client-side over the same HTTP endpoints the CLI
// export uses (projects → issues → comments per issue; activities skipped,
// children stay flat with parentId). Mirrors apps/cli/src/commands/export.ts
// in compact form — MCP cannot depend on the CLI package, and the payloads
// must stay identical (same exportedAt/source/projects shape).
import { z } from '@taskboard/core/schemas';
import { base, ensureServerOrThrow } from '../connection.js';
import { defineTool, type ToolTable } from './registry.js';

interface ExportComment { author: string; body: string }

interface ExportIssue {
  id: string;
  title: string;
  status?: string;
  priority?: string;
  assignee?: string;
  branch?: string;
  worktree?: string;
  startDate?: string | null;
  dueDate?: string | null;
  version?: number;
  archivedAt?: string | null;
  description?: string;
  comments?: ExportComment[];
  [field: string]: unknown;
}

interface ExportProject { id: string; name: string; issues: ExportIssue[]; [field: string]: unknown }

interface ProjectListEntry { id: string }

const STATUS_ICONS: Record<string, string> = {
  todo: '○', in_progress: '◐', in_review: '◑', done: '●'
};

const dash = (value: unknown): string => {
  const text = value === null || value === undefined ? '' : String(value);
  return text === '' ? '-' : text;
};

async function gatherProject(projectId: string): Promise<ExportProject> {
  const project = await ensureServerOrThrow('GET', `/api/projects/${projectId}`) as ExportProject;
  const issues = await ensureServerOrThrow(
    'GET', `/api/projects/${projectId}/issues?archived=all`
  ) as ExportIssue[];
  for (const issue of issues) {
    issue.comments = await ensureServerOrThrow('GET', `/api/issues/${issue.id}/comments`) as ExportComment[];
  }
  return { ...project, issues };
}

async function gatherBoard(projectId?: string): Promise<ExportProject[]> {
  if (projectId !== undefined) return [await gatherProject(projectId)];
  const projects: ExportProject[] = [];
  const listed = await ensureServerOrThrow('GET', '/api/projects') as ProjectListEntry[];
  for (const p of listed) projects.push(await gatherProject(p.id));
  return projects;
}

const metaLine = (issue: ExportIssue): string => {
  const meta = [
    `状态: ${dash(issue.status)}`, `优先级: ${dash(issue.priority)}`, `负责人: ${dash(issue.assignee)}`,
    `分支: ${dash(issue.branch)}`, `worktree: ${dash(issue.worktree)}`,
    `日期: ${dash(issue.startDate)} → ${dash(issue.dueDate)}`, `版本: v${dash(issue.version)}`
  ].join(' · ');
  return issue.archivedAt ? `${meta} · 已归档` : meta;
};

function renderMarkdown(payload: { exportedAt: string; source: string; projects: ExportProject[] }): string {
  const lines: string[] = ['# open-taskboard 导出', '', `> ${payload.exportedAt} · ${payload.source}`, ''];
  for (const project of payload.projects) {
    lines.push(`## ${project.name} (${project.id})`, '');
    for (const issue of project.issues) {
      const icon = STATUS_ICONS[String(issue.status)] ?? '○';
      lines.push(`### ${icon} #${issue.id} ${issue.title}`, '');
      lines.push(metaLine(issue), '');
      if (issue.description) lines.push(String(issue.description), '');
      const comments = issue.comments ?? [];
      if (comments.length) {
        lines.push('#### 评论', '');
        for (const c of comments) lines.push(`- ${c.author || 'anon'}: ${c.body}`);
        lines.push('');
      }
      lines.push('---', '');
    }
  }
  return lines.join('\n');
}

export const exportTools: ToolTable = [
  ['export_board', defineTool(
    z.object({
      format: z.enum(['json', 'md']).optional().describe('输出格式，默认 json'),
      projectId: z.string().optional().describe('只导出该项目；缺省导出全部项目'),
    }).strict(),
    '导出看板（或单个项目）为 JSON / Markdown 文本：项目 + 任务 + 每条任务的评论（子任务保持扁平 parentId，不含活动记录）',
    async args => {
      const projects = await gatherBoard(args.projectId);
      const payload = { exportedAt: new Date().toISOString(), source: base(), projects };
      return (args.format ?? 'json') === 'md' ? renderMarkdown(payload) : JSON.stringify(payload, null, 2);
    },
  )     ],
];

