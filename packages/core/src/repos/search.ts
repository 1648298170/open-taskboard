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
   * insensitive contains over title/description, archived rows excluded,
   * standard list order. Returns bare issues.
   */
  likeScan(needle: string): Issue[] {
    const escaped = needle.replace(/[\\%_]/g, m => `\\${m}`);
    return this.db.prepare(
      `SELECT id, project_id AS projectId, parent_id AS parentId, title, description,
         status, priority, labels, branch, worktree, archived_at AS archivedAt, assignee, version,
         start_date AS startDate, due_date AS dueDate, created_at AS createdAt, updated_at AS updatedAt
       FROM issues
       WHERE archived_at IS NULL AND (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
       ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at`
    ).all(`%${escaped}%`, `%${escaped}%`) as unknown as Issue[];
  }
}
