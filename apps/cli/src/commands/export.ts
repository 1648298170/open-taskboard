// T4-22: board export — whole board or one project, JSON or Markdown.
// Data comes over the HTTP API only, using the efficient path: projects list
// → issues list (archived=all: an export is a snapshot, losing archived rows
// would be silent data loss) → comments per issue. The show endpoint's extra
// payloads (children/activities) are skipped; children stay FLAT with their
// parentId — no artificial nesting in either format.
import { writeFileSync } from 'node:fs';
import { need, seg, type ApiClient, type Command } from './registry.js';

export interface ExportComment {
  id: string;
  issueId: string;
  author: string;
  body: string;
  createdAt: string;
}

/** One issue as returned by the list endpoint, plus its comments. */
export interface ExportIssue {
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

/** One project with its flat issue list (children included, parentId kept). */
export interface ExportProject {
  id: string;
  name: string;
  issues: ExportIssue[];
  [field: string]: unknown;
}

export interface ExportPayload {
  exportedAt: string;
  source: string;
  projects: ExportProject[];
}

/** Fetch one project + its issues + per-issue comments over the HTTP API. */
export async function gatherProject(api: ApiClient, projectId: string): Promise<ExportProject> {
  const project = await api('GET', `/api/projects/${seg(projectId)}`);
  const issues: ExportIssue[] = await api('GET', `/api/projects/${seg(projectId)}/issues?archived=all`);
  for (const issue of issues) {
    issue.comments = await api('GET', `/api/issues/${seg(issue.id)}/comments`);
  }
  return { ...project, issues };
}

/** Assemble the full export payload: all projects (or the one requested). */
export async function gatherBoard(api: ApiClient, projectId?: string): Promise<ExportProject[]> {
  if (projectId !== undefined) return [await gatherProject(api, projectId)];
  const projects: ExportProject[] = [];
  for (const p of await api('GET', '/api/projects')) projects.push(await gatherProject(api, p.id));
  return projects;
}

const STATUS_ICONS: Record<string, string> = {
  todo: '○', in_progress: '◐', in_review: '◑', done: '●'
};

/** Metadata value rendering: null/undefined/'' all collapse to '-'. */
const dash = (value: unknown): string => {
  const text = value === null || value === undefined ? '' : String(value);
  return text === '' ? '-' : text;
};

const metaLine = (issue: ExportIssue): string => {
  const meta = [
    `状态: ${dash(issue.status)}`,
    `优先级: ${dash(issue.priority)}`,
    `负责人: ${dash(issue.assignee)}`,
    `分支: ${dash(issue.branch)}`,
    `worktree: ${dash(issue.worktree)}`,
    `日期: ${dash(issue.startDate)} → ${dash(issue.dueDate)}`,
    `版本: v${dash(issue.version)}`
  ].join(' · ');
  return issue.archivedAt ? `${meta} · 已归档` : meta;
};

/** Render the payload as the `# open-taskboard 导出` Markdown document. */
export function renderMarkdown(payload: ExportPayload): string {
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

export const exportCommand: Command = {
  summary: 'Export the board (or one project) as JSON or Markdown',
  usage: 'export [--project ID] [--format json|md] [--out FILE]',
  async run(ctx) {
    const { api, base, flags } = ctx;
    const format = String(flags.format ?? 'json');
    need(format === 'json' || format === 'md', 'export [--project ID] [--format json|md] [--out FILE]');
    const projects = await gatherBoard(api, flags.project !== undefined ? String(flags.project) : undefined);
    const payload: ExportPayload = { exportedAt: new Date().toISOString(), source: base(), projects };
    const out = format === 'json' ? JSON.stringify(payload, null, 2) : renderMarkdown(payload);
    if (flags.out !== undefined) {
      writeFileSync(String(flags.out), out);
      console.log(`exported to ${String(flags.out)}`);
    } else {
      console.log(out);
    }
  }
};
