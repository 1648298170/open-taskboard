import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { Issue, IssuePatch, PRIORITIES, Priority, STATUSES, Status } from '../types.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';

const ISSUE_COLS = `id, project_id AS projectId, parent_id AS parentId, title, description,
  status, priority, labels, branch, worktree, worktree_path AS worktreePath,
  session_id AS sessionId, archived_at AS archivedAt,
  claimed_by AS claimedBy, lease_expires_at AS leaseExpiresAt, assignee, version,
  start_date AS startDate, due_date AS dueDate,
  started_at AS startedAt, completed_at AS completedAt,
  acceptance_criteria AS acceptanceCriteria, review_status AS reviewStatus, review_notes AS reviewNotes,
  created_at AS createdAt, updated_at AS updatedAt`;
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
    labels?: string; branch?: string; worktree?: string | null; worktreePath?: string | null; assignee?: string;
    sessionId?: string | null;
    startDate?: string | null; dueDate?: string | null;
    acceptanceCriteria?: string; reviewStatus?: 'pending' | 'approved' | 'changes_requested'; reviewNotes?: string;
  }): string {
    const status = input.status ?? 'todo';
    const priority = input.priority ?? 'medium';
    assertValidStatus(status);
    assertValidPriority(priority);
    const reviewStatus = input.reviewStatus ?? 'pending';
    if (!['pending', 'approved', 'changes_requested'].includes(reviewStatus)) {
      throw new ValidationError(`invalid reviewStatus: ${reviewStatus}`);
    }
    const id = shortId();
    const t = now();
    this.db.prepare(
`INSERT INTO issues (id, project_id, parent_id, title, description, status, priority, labels, branch, worktree, worktree_path, session_id, assignee, version, start_date, due_date, acceptance_criteria, review_status, review_notes, claimed_by, lease_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, '', NULL, ?, ?)`
    ).run(id, input.projectId, input.parentId, input.title, input.description ?? '', status, priority,
      input.labels ?? '', input.branch ?? '', input.worktree ?? '', input.worktreePath ?? '', input.sessionId ?? null, input.assignee ?? '', input.startDate ?? null,
      input.dueDate ?? null, input.acceptanceCriteria ?? '', reviewStatus, input.reviewNotes ?? '', t, t);
    return id;
  }

  get(id: string): Issue | null {
    return this.db.prepare(`SELECT ${ISSUE_COLS} FROM issues WHERE id = ?`).get(id) as unknown as Issue | null;
  }

  list(projectId: string, opts: { status?: Status; parentId?: string | null; includeDone?: boolean; archived?: 'only' | 'all' } = {}): Issue[] {
    const where = ['project_id = ?'];
    const args: SQLInputValue[] = [projectId];
    if (opts.status) { where.push('status = ?'); args.push(opts.status); }
    if (opts.parentId !== undefined) {
      if (opts.parentId === null) where.push('parent_id IS NULL');
      else { where.push('parent_id = ?'); args.push(opts.parentId); }
    }
    if (opts.includeDone === false) where.push("status != 'done'");
    // T5-24: default (undefined) excludes archived rows; 'only' selects just
    // them; 'all' adds no clause.
    if (opts.archived === 'only') where.push('archived_at IS NOT NULL');
    else if (opts.archived !== 'all') where.push('archived_at IS NULL');
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
      ['worktree', 'worktree'], ['worktreePath', 'worktree_path'], ['sessionId', 'session_id'],
      ['assignee', 'assignee'], ['parentId', 'parent_id'],
      ['startDate', 'start_date'], ['dueDate', 'due_date'],
      ['startedAt', 'started_at'], ['completedAt', 'completed_at'],
      ['acceptanceCriteria', 'acceptance_criteria'], ['reviewStatus', 'review_status'], ['reviewNotes', 'review_notes']
    ];
    for (const [key, col] of colMap) {
      const v = patch[key];
      if (v === undefined) continue;
      if (key === 'status') assertValidStatus(v as Status);
      if (key === 'priority') assertValidPriority(v as Priority);
      if (key === 'reviewStatus' && !['pending', 'approved', 'changes_requested'].includes(String(v))) {
        throw new ValidationError(`invalid reviewStatus: ${String(v)}`);
      }
      sets.push(`${col} = ?`);
      // String binding columns are NOT NULL; null explicitly clears the binding.
      args.push((key === 'worktree' || key === 'worktreePath') && v === null ? '' : v);
    }
    if (!sets.length) return { changed: false };
    sets.push('version = version + 1', 'updated_at = ?');
    args.push(now(), id);
    this.db.prepare(`UPDATE issues SET ${sets.join(', ')} WHERE id = ?`).run(...args);
    return { changed: true };
  }

  // T5-24: archive / unarchive. A row mutation like update(), so it bumps
  // version + updated_at to keep optimistic-lock consistency. Caller wraps
  // in a transaction and owns existence checks / activity / events.
  setArchived(id: string, archivedAt: string | null): void {
    this.db.prepare(
      'UPDATE issues SET archived_at = ?, version = version + 1, updated_at = ? WHERE id = ?'
    ).run(archivedAt, now(), id);
  }

  // T7-34: exclusive claim writes. claim (and release) are row mutations
  // like update() — version + updated_at bump so optimistic-lock clients
  // see the change. heartbeat touches ONLY the lease deadline: a renewal
  // must not invalidate optimistic-lock clients (no version, no updated_at).
  // Caller wraps in a transaction and owns preconditions / activity / events.
  setClaim(id: string, agent: string, claimedAt: string, leaseExpiresAt: string, expectedHolder: string): boolean {
    // T7-34 CAS: only fire when the lease still belongs to the holder the
    // caller observed ('' = unclaimed) AND that observation is still true —
    // a holder that RENEWED between the caller's read and this write (active
    // lease) must not be stolen by a third party; the holder itself renewing
    // its own active lease stays allowed (re-entrant). Changes = 0 means
    // someone else moved first.
    const r = this.db.prepare(
      `UPDATE issues SET claimed_by = ?, claimed_at = ?, lease_expires_at = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND claimed_by = ?
         AND (claimed_by = ? OR lease_expires_at IS NULL OR lease_expires_at <= ?)`
    ).run(agent, claimedAt, leaseExpiresAt, now(), id, expectedHolder, agent, claimedAt);
    return Number(r.changes) > 0;
  }

  extendLease(id: string, leaseExpiresAt: string, expectedHolder: string): boolean {
    const r = this.db.prepare(
      'UPDATE issues SET lease_expires_at = ? WHERE id = ? AND claimed_by = ?'
    ).run(leaseExpiresAt, id, expectedHolder);
    return Number(r.changes) > 0;
  }

  clearClaim(id: string, expectedHolder: string): boolean {
    const r = this.db.prepare(
      "UPDATE issues SET claimed_by = '', claimed_at = NULL, lease_expires_at = NULL, version = version + 1, updated_at = ? WHERE id = ? AND claimed_by = ?"
    ).run(now(), id, expectedHolder);
    return Number(r.changes) > 0;
  }

  /** ids of `id` plus every descendant (children-first order irrelevant here; read-only). */
  subtreeIds(id: string): string[] {
    const out: string[] = [];
    const walk = (cur: string): void => {
      out.push(cur);
      for (const c of this.db.prepare('SELECT id FROM issues WHERE parent_id = ?').all(cur) as { id: string }[]) {
        walk(c.id);
      }
    };
    walk(id);
    return out;
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
