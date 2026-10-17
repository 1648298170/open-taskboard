// v0.4 P0: import — the missing half of export. Recreates an ExportPayload
// on the target board over the public API only (orchestration belongs to the
// CLI; domain writes stay in core): project → top-level issues → children →
// comments → archived flags → dependency edges. Issue/comment ids always
// regenerate (the API has no id override); a project id that already exists
// on the board rejects that project's import unless --project renames it.
// NOT atomic: a mid-import network failure leaves partial data — use
// --dry-run to preview, and import into a fresh board for guarantees.
import { readFileSync } from 'node:fs';
import { need, seg, type ApiClient, type Command } from './registry.js';
import type { ExportIssue, ExportPayload, ExportProject } from './export.js';

interface FlatIssue extends ExportIssue {
  parentId?: string | null;
  labels?: string;
}

async function exists(base: () => string, token: () => string, projectId: string): Promise<boolean> {
  // api() exits the process on any non-2xx — existence probing needs a
  // 404-tolerant request, so this one uses fetch directly.
  const res = await fetch(`${base()}/api/projects/${seg(projectId)}`, {
    headers: token() ? { Authorization: `Bearer ${token()}` } : {}
  });
  return res.ok;
}

function parsePayload(file: string): ExportPayload & { projects: (ExportProject & { dependencies?: { issueId: string; dependsOnId: string }[] })[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`error: cannot read ${file} (${(err as Error).message})`);
    process.exit(1);
  }
  const projects = (raw as { projects?: unknown }).projects;
  if (!Array.isArray(projects) || projects.length === 0) {
    console.error('error: not an export payload (missing non-empty projects[])');
    process.exit(1);
  }
  return raw as ExportPayload & { projects: (ExportProject & { dependencies?: { issueId: string; dependsOnId: string }[] })[] };
}

async function importProject(
  api: ApiClient,
  base: () => string,
  token: () => string,
  proj: ExportProject & { dependencies?: { issueId: string; dependsOnId: string }[] },
  targetId: string,
  dryRun: boolean
): Promise<boolean> {
  const issues = (proj.issues ?? []) as FlatIssue[];
  const commentCount = issues.reduce((n, i) => n + (i.comments?.length ?? 0), 0);
  const deps = proj.dependencies ?? [];
  const conflict = await exists(base, token, targetId);
  console.log(`${dryRun ? '[dry-run] ' : ''}project ${targetId}: ${issues.length} issues, ${commentCount} comments, ${deps.length} dependencies${conflict ? '  ⚠ id already exists' : ''}`);
  if (conflict) {
    console.error(`error: project ${targetId} already exists on this board — rename with --project or delete it first`);
    return false;
  }
  if (dryRun) return true;

  const rawWorkspace = (proj as { workspacePath?: unknown }).workspacePath;
  await api('POST', '/api/projects', {
    id: targetId, name: proj.name,
    workspacePath: typeof rawWorkspace === 'string' ? rawWorkspace : ''
  });
  const idMap = new Map<string, string>();
  const tops = issues.filter(i => !i.parentId);
  const kids = issues.filter(i => i.parentId);
  for (const issue of [...tops, ...kids]) {
    const created = await api('POST', `/api/projects/${targetId}/issues`, {
      title: issue.title,
      description: issue.description ?? '',
      status: issue.status ?? 'todo',
      priority: issue.priority ?? 'medium',
      labels: issue.labels ?? '',
      branch: issue.branch ?? '',
      worktree: issue.worktree ?? null,
      assignee: issue.assignee ?? '',
      startDate: issue.startDate ?? null,
      dueDate: issue.dueDate ?? null,
      parentId: issue.parentId ? idMap.get(issue.parentId) ?? null : null
    }) as { id: string };
    idMap.set(issue.id, created.id);
    if (issue.archivedAt) await api('POST', `/api/issues/${created.id}/archive`, {});
    for (const c of issue.comments ?? []) {
      await api('POST', `/api/issues/${created.id}/comments`, { author: c.author, body: c.body });
    }
  }
  for (const d of deps) {
    const from = idMap.get(d.issueId);
    const to = idMap.get(d.dependsOnId);
    if (!from || !to) {
      console.error(`warn: dependency edge ${d.issueId}→${d.dependsOnId} skipped (id outside payload)`);
      continue;
    }
    await api('POST', `/api/issues/${from}/dependencies`, { dependsOnId: to });
  }
  console.log(`imported ${targetId}: ${idMap.size} issues, ${commentCount} comments, ${deps.length} dependencies`);
  return true;
}

export const importCommand: Command = {
  summary: 'Import an export JSON file onto this board',
  usage: 'import FILE [--project NEW_ID] [--dry-run]',
  bare: true,
  async run(ctx) {
    const { api, base, token, flags, rest } = ctx;
    need(!!rest[0], 'import FILE [--project NEW_ID] [--dry-run]');
    const payload = parsePayload(String(rest[0]));
    if (flags.project !== undefined && payload.projects.length > 1) {
      console.error('error: --project applies only to a single-project payload');
      process.exit(1);
    }
    const dryRun = flags['dry-run'] === true;
    let allOk = true;
    for (const proj of payload.projects) {
      const targetId = String(flags.project ?? proj.id);
      const ok = await importProject(api, base, token, proj, targetId, dryRun);
      allOk = allOk && ok;
    }
    if (!allOk) process.exit(1);
  }
};
