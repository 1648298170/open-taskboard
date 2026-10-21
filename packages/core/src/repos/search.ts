import type { DatabaseSync } from 'node:sqlite';
import type { Issue } from '../types.js';

/** One FTS hit: what text matched, which row it belongs to, which project. */
export interface FtsHit {
  refId: string;
  kind: string;
  projectId: string;
}

// SQL layer over the issues_fts virtual table (T6-30). The index is
// application-maintained: the Store calls these helpers inside the same
// transactions as the mutations they mirror, so index and data never drift.
//
// DELETE predicates use equality only — FTS5 silently ignores DELETEs whose
// WHERE clause filters UNINDEXED columns with LIKE (verified against
// node:sqlite); `kind IN (...)` / `ref_id = ?` / `project_id = ?` all work.
export class SearchRepo {
  constructor(private db: DatabaseSync) {}

  /** True when the FTS5 virtual table exists (migration skipped on FTS-less builds). */
  available(): boolean {
    return this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'issues_fts'"
    ).get() !== undefined;
  }

  indexIssue(issueId: string, projectId: string, title: string, description: string): void {
    this.db.prepare(
      "INSERT INTO issues_fts (text, ref_id, kind, project_id) VALUES (?, ?, 'issue-title', ?)"
    ).run(title, issueId, projectId);
    this.db.prepare(
      "INSERT INTO issues_fts (text, ref_id, kind, project_id) VALUES (?, ?, 'issue-desc', ?)"
    ).run(description, issueId, projectId);
  }

  /** updateIssue sync: drop both issue rows, re-insert current texts. */
  reindexIssue(issueId: string, projectId: string, title: string, description: string): void {
    this.db.prepare(
      "DELETE FROM issues_fts WHERE ref_id = ? AND kind IN ('issue-title', 'issue-desc')"
    ).run(issueId);
    this.indexIssue(issueId, projectId, title, description);
  }

  indexComment(commentId: string, projectId: string, body: string): void {
    this.db.prepare(
      "INSERT INTO issues_fts (text, ref_id, kind, project_id) VALUES (?, ?, 'comment', ?)"
    ).run(body, commentId, projectId);
  }

  /** Must run BEFORE the issue/comments rows are deleted (subquery reads comments). */
  deleteIssueFts(issueId: string): void {
    this.db.prepare(
      `DELETE FROM issues_fts WHERE (ref_id = ? AND kind IN ('issue-title', 'issue-desc'))
         OR (kind = 'comment' AND ref_id IN (SELECT id FROM comments WHERE issue_id = ?))`
    ).run(issueId, issueId);
  }

  /** Single comment FTS row (comment deletion path). */
  deleteCommentFts(commentId: string): void {
    this.db.prepare("DELETE FROM issues_fts WHERE kind = 'comment' AND ref_id = ?").run(commentId);
  }

  /** Must run BEFORE the project rows are deleted. Every fts row carries project_id. */
  deleteProjectFts(projectId: string): void {
    this.db.prepare('DELETE FROM issues_fts WHERE project_id = ?').run(projectId);
  }

  /** Raw FTS match; the caller is responsible for quoting the query. */
  match(matchExpr: string): FtsHit[] {
    return this.db.prepare(
      'SELECT ref_id AS refId, kind, project_id AS projectId FROM issues_fts WHERE issues_fts MATCH ?'
    ).all(matchExpr) as unknown as FtsHit[];
  }

  /**
   * LIKE fallback for engines without FTS5 (and short queries): case-
   * insensitive contains over title/description AND comment bodies (a
   * comment hit maps to its parent issue), archived rows excluded,
   * standard list order. Returns bare issues.
   */
  likeScan(needle: string): Issue[] {
    const escaped = needle.replace(/[\\%_]/g, m => `\\${m}`);
    return this.db.prepare(
      `SELECT i.id, i.project_id AS projectId, i.parent_id AS parentId, i.title, i.description,
         i.status, i.priority, i.labels, i.branch, i.worktree, i.worktree_path AS worktreePath,
         i.archived_at AS archivedAt, i.claimed_by AS claimedBy, i.lease_expires_at AS leaseExpiresAt,
         p.default_session_id AS sessionId, i.assignee, i.version,
         i.start_date AS startDate, i.due_date AS dueDate, i.created_at AS createdAt, i.updated_at AS updatedAt
       FROM issues i LEFT JOIN projects p ON p.id = i.project_id
       WHERE i.archived_at IS NULL AND (
           i.title LIKE ? ESCAPE '\\'
        OR i.description LIKE ? ESCAPE '\\'
        OR i.id IN (SELECT issue_id FROM comments WHERE body LIKE ? ESCAPE '\\'))
       ORDER BY CASE i.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, i.created_at`
    ).all(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`) as unknown as Issue[];
  }}
