import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { Issue, IssuePatch, PRIORITIES, Priority, STATUSES, Status } from '../types.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';

const ISSUE_COLS = `id, project_id AS projectId, parent_id AS parentId, title, description,
  status, priority, labels, branch, assignee, version, created_at AS createdAt, updated_at AS updatedAt`;
const now = (): string => new Date().toISOString();
const shortId = (): string => randomUUID().slice(0, 8);

// The single place where write-path status/priority validation happens.
function assertValidStatus(status: Status): void {
  if (!STATUSES.includes(status)) throw new ValidationError(`invalid status: ${status}`);
}
function assertValidPriority(priority: Priority): void {
  if (!PRIORITIES.includes(priority)) throw new ValidationError(`invalid priority: ${priority}`);
}

export class IssueRepo {
  constructor(private db: DatabaseSync) {}

  create(input: {
    projectId: string; parentId: string | null; title: string;
    description?: string; status?: Status; priority?: Priority;
    labels?: string; branch?: string; assignee?: string;
  }): string {
    const status = input.status ?? 'todo';
    const priority = input.priority ?? 'medium';
    assertValidStatus(status);
    assertValidPriority(priority);
    const id = shortId();
    const t = now();
    this.db.prepare(
      `INSERT INTO issues (id, project_id, parent_id, title, description, status, priority, labels, branch, assignee, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(id, input.projectId, input.parentId, input.title, input.description ?? '', status, priority,
      input.labels ?? '', input.branch ?? '', input.assignee ?? '', t, t);
    return id;
  }

  get(id: string): Issue | null {
    return this.db.prepare(`SELECT ${ISSUE_COLS} FROM issues WHERE id = ?`).get(id) as unknown as Issue | null;
  }

  list(projectId: string, opts: { status?: Status; parentId?: string | null; includeDone?: boolean } = {}): Issue[] {
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

  // Optimistic-lock check + patch application. Returns whether a write actually
  // happened: an empty patch is a no-op (no version bump, no updated_at touch).
  update(id: string, patch: IssuePatch, expectedVersion?: number): { changed: boolean } {
    const cur = this.get(id);
    if (!cur) throw new NotFoundError(`issue not found: ${id}`);
    if (expectedVersion !== undefined && expectedVersion !== cur.version) {
      throw new ConflictError(`version conflict: issue ${id} is at v${cur.version}, client sent v${expectedVersion}. Re-read and retry.`);
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
      if (key === 'status') assertValidStatus(v as Status);
      if (key === 'priority') assertValidPriority(v as Priority);
      sets.push(`${col} = ?`);
      args.push(v);
    }
    if (!sets.length) return { changed: false };
    sets.push('version = version + 1', 'updated_at = ?');
    args.push(now(), id);
    this.db.prepare(`UPDATE issues SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    return { changed: true };
  }

  // Recursive DELETE only — collects deleted ids children-first; no transaction,
  // no events. The caller owns both.
  deleteRecursively(id: string): string[] {
    const deleted: string[] = [];
    this.deleteRec(id, deleted);
    return deleted;
  }

  private deleteRec(id: string, deleted: string[]): void {
    for (const c of this.db.prepare('SELECT id FROM issues WHERE parent_id = ?').all(id) as { id: string }[]) {
      this.deleteRec(c.id, deleted);
    }
    this.db.prepare('DELETE FROM comments WHERE issue_id = ?').run(id);
    this.db.prepare('DELETE FROM issues WHERE id = ?').run(id);
    deleted.push(id);
  }
}
