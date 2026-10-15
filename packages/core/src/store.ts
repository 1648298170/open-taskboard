import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  Comment, Issue, IssuePatch, PRIORITIES, Priority, Progress, Project,
  STATUSES, Status, StoreEvent
} from './types.js';

const ISSUE_COLS = `id, project_id AS projectId, parent_id AS parentId, title, description,
  status, priority, labels, branch, assignee, version, created_at AS createdAt, updated_at AS updatedAt`;
const now = (): string => new Date().toISOString();
const shortId = (): string => randomUUID().slice(0, 8);

type Listener = (event: StoreEvent) => void;

export class Store {
  private db: DatabaseSync;
  private listeners = new Set<Listener>();

  constructor(dataDir = '.data') {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'taskboard.sqlite'));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL,
        workspace_path TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        parent_id TEXT REFERENCES issues(id),
        title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'todo', priority TEXT NOT NULL DEFAULT 'medium',
        labels TEXT NOT NULL DEFAULT '', branch TEXT NOT NULL DEFAULT '',
        assignee TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        author TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);
      CREATE INDEX IF NOT EXISTS idx_issues_parent ON issues(parent_id);
      CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments(issue_id);
    `);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(type: string, payload: Record<string, unknown>): void {
    const event: StoreEvent = { type, payload, revision: this.revision(), at: now() };
    for (const fn of this.listeners) {
      try { fn(event); } catch { /* client gone */ }
    }
  }

  revision(): number {
    return this.db.prepare(
      `SELECT (SELECT COUNT(*) FROM projects) + (SELECT COUNT(*) FROM issues) * 10
             + (SELECT COUNT(*) FROM comments) * 100
             + (SELECT COALESCE(SUM(version),0) FROM issues) AS rev`
    ).get()!.rev as number;
  }

  // ---- projects ----
  createProject(input: { id?: string; name: string; workspacePath?: string }): Project {
    const id = input.id || shortId();
    this.db.prepare('INSERT INTO projects (id, name, workspace_path, created_at) VALUES (?, ?, ?, ?)')
      .run(id, input.name, input.workspacePath ?? '', now());
    this.emit('project.created', { id });
    return this.getProject(id)!;
  }

  listProjects(): Project[] {
    return this.db.prepare('SELECT id, name, workspace_path AS workspacePath, created_at AS createdAt FROM projects ORDER BY created_at').all() as unknown as Project[];
  }

  getProject(id: string): Project | null {
    return this.db.prepare('SELECT id, name, workspace_path AS workspacePath, created_at AS createdAt FROM projects WHERE id = ?').get(id) as unknown as Project | null;
  }

  deleteProject(id: string): void {
    if (!this.getProject(id)) throw new Error(`project not found: ${id}`);
    this.db.prepare('DELETE FROM comments WHERE issue_id IN (SELECT id FROM issues WHERE project_id = ?)').run(id);
    this.db.prepare('DELETE FROM issues WHERE project_id = ?').run(id);
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    this.emit('project.deleted', { id });
  }

  // ---- issues ----
  createIssue(input: {
    projectId: string; parentId?: string | null; title: string;
    description?: string; status?: Status; priority?: Priority;
    labels?: string; branch?: string; assignee?: string;
  }): Issue {
    const { projectId, title } = input;
    const parentId = input.parentId ?? null;
    if (!this.getProject(projectId)) throw new Error(`project not found: ${projectId}`);
    if (parentId && !this.getIssue(parentId)) throw new Error(`parent issue not found: ${parentId}`);
    if (parentId && this.getIssue(parentId)!.parentId) throw new Error('only one level of nesting is supported (parent must be a top-level issue)');
    const status = input.status ?? 'todo';
    const priority = input.priority ?? 'medium';
    if (!STATUSES.includes(status)) throw new Error(`invalid status: ${status}`);
    if (!PRIORITIES.includes(priority)) throw new Error(`invalid priority: ${priority}`);
    const id = shortId();
    const t = now();
    this.db.prepare(
      `INSERT INTO issues (id, project_id, parent_id, title, description, status, priority, labels, branch, assignee, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(id, projectId, parentId, title, input.description ?? '', status, priority,
      input.labels ?? '', input.branch ?? '', input.assignee ?? '', t, t);
    this.emit('issue.created', { id, projectId });
    return this.getIssue(id)!;
  }

  getIssue(id: string): Issue | null {
    return this.db.prepare(`SELECT ${ISSUE_COLS} FROM issues WHERE id = ?`).get(id) as unknown as Issue | null;
  }

  listIssues(projectId: string, opts: { status?: Status; parentId?: string | null; includeDone?: boolean } = {}): Issue[] {
    const where = ['project_id = ?'];
    const args: SQLInputValue[] = [projectId];
    if (opts.status) { where.push('status = ?'); args.push(opts.status); }
    if (opts.parentId !== undefined) {
      if (opts.parentId === null) where.push('parent_id IS NULL');
      else { where.push('parent_id = ?'); args.push(opts.parentId); }
    }
    if (opts.includeDone === false) where.push("status != 'done'");
    return this.db.prepare(
      `SELECT ${ISSUE_COLS} FROM issues WHERE ${where.join(' AND ')}
       ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at`
    ).all(...args) as unknown as Issue[];
  }

  updateIssue(id: string, patch: IssuePatch, expectedVersion?: number): Issue {
    const cur = this.getIssue(id);
    if (!cur) throw new Error(`issue not found: ${id}`);
    if (expectedVersion !== undefined && expectedVersion !== cur.version) {
      throw new Error(`version conflict: issue ${id} is at v${cur.version}, client sent v${expectedVersion}. Re-read and retry.`);
    }
    const sets: string[] = [];
    const args: SQLInputValue[] = [];
    const colMap: [keyof IssuePatch, string][] = [
      ['title', 'title'], ['description', 'description'], ['status', 'status'],
      ['priority', 'priority'], ['labels', 'labels'], ['branch', 'branch'],
      ['assignee', 'assignee'], ['parentId', 'parent_id']
    ];
    for (const [key, col] of colMap) {
      const v = patch[key];
      if (v === undefined) continue;
      if (key === 'status' && !STATUSES.includes(v as Status)) throw new Error(`invalid status: ${v}`);
      if (key === 'priority' && !PRIORITIES.includes(v as Priority)) throw new Error(`invalid priority: ${v}`);
      sets.push(`${col} = ?`);
      args.push(v);
    }
    if (!sets.length) return cur;
    sets.push('version = version + 1', 'updated_at = ?');
    args.push(now(), id);
    this.db.prepare(`UPDATE issues SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    this.emit('issue.updated', { id });
    return this.getIssue(id)!;
  }

  deleteIssue(id: string): void {
    const cur = this.getIssue(id);
    if (!cur) throw new Error(`issue not found: ${id}`);
    for (const c of this.db.prepare('SELECT id FROM issues WHERE parent_id = ?').all(id) as { id: string }[]) {
      this.deleteIssue(c.id);
    }
    this.db.prepare('DELETE FROM comments WHERE issue_id = ?').run(id);
    this.db.prepare('DELETE FROM issues WHERE id = ?').run(id);
    this.emit('issue.deleted', { id });
  }

  // ---- comments ----
  addComment(issueId: string, input: { author?: string; body: string }): Comment {
    if (!this.getIssue(issueId)) throw new Error(`issue not found: ${issueId}`);
    const id = shortId();
    this.db.prepare('INSERT INTO comments (id, issue_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, issueId, input.author ?? '', input.body, now());
    this.db.prepare('UPDATE issues SET updated_at = ? WHERE id = ?').run(now(), issueId);
    this.emit('comment.created', { id, issueId });
    return this.getComment(id)!;
  }

  getComment(id: string): Comment | null {
    return this.db.prepare('SELECT id, issue_id AS issueId, author, body, created_at AS createdAt FROM comments WHERE id = ?').get(id) as unknown as Comment | null;
  }

  listComments(issueId: string): Comment[] {
    return this.db.prepare('SELECT id, issue_id AS issueId, author, body, created_at AS createdAt FROM comments WHERE issue_id = ? ORDER BY created_at').all(issueId) as unknown as Comment[];
  }

  // ---- progress: one top-level issue = one unit, equal weight (dashi #371) ----
  projectProgress(projectId: string): Progress {
    const all = this.listIssues(projectId);
    const top = all.filter(i => !i.parentId);
    const done = (list: Issue[]): number => list.filter(i => i.status === 'done').length;
    const completedTop = top.filter(t =>
      t.status === 'done' ||
      (all.some(i => i.parentId === t.id) && all.filter(i => i.parentId === t.id).every(k => k.status === 'done'))
    ).length;
    return {
      total: all.length,
      done: done(all),
      topTotal: top.length,
      topDone: done(top),
      weightedDone: completedTop,
      weightedTotal: top.length
    };
  }
}
