import type { DatabaseSync } from 'node:sqlite';
import type { DependencyEdge } from '../types.js';

/** Per-issue dependency view: who blocks me (blockedBy), whom I block (blocks). */
export interface DependencyPair {
  blockedBy: string[];
  blocks: string[];
}

// Thin SQL layer over issue_dependencies. Cross-aggregate preconditions
// (existence, same-project, cycle guard) live in the Store; FK cascades keep
// the table consistent when issues are deleted.
export class DependencyRepo {
  constructor(private db: DatabaseSync) {}

  add(issueId: string, dependsOnId: string, createdAt: string): void {
    this.db.prepare(
      'INSERT INTO issue_dependencies (issue_id, depends_on_id, created_at) VALUES (?, ?, ?)'
    ).run(issueId, dependsOnId, createdAt);
  }

  remove(issueId: string, dependsOnId: string): void {
    this.db.prepare('DELETE FROM issue_dependencies WHERE issue_id = ? AND depends_on_id = ?')
      .run(issueId, dependsOnId);
  }

  exists(issueId: string, dependsOnId: string): boolean {
    return this.db.prepare(
      'SELECT 1 AS one FROM issue_dependencies WHERE issue_id = ? AND depends_on_id = ?'
    ).get(issueId, dependsOnId) !== undefined;
  }

  // blockedBy = rows where issue_id = ?; blocks = rows where depends_on_id = ?.
  // created_at order keeps both lists stable (insertion order).
  listForIssue(issueId: string): DependencyPair {
    const blockedBy = this.db.prepare(
      'SELECT depends_on_id AS id FROM issue_dependencies WHERE issue_id = ? ORDER BY created_at, rowid'
    ).all(issueId) as { id: string }[];
    const blocks = this.db.prepare(
      'SELECT issue_id AS id FROM issue_dependencies WHERE depends_on_id = ? ORDER BY created_at, rowid'
    ).all(issueId) as { id: string }[];
    return { blockedBy: blockedBy.map(r => r.id), blocks: blocks.map(r => r.id) };
  }

  // Project-scoped edge list (JOIN keeps edges of other projects out).
  listByProject(projectId: string): DependencyEdge[] {
    return this.db.prepare(
      `SELECT issue_id AS issueId, depends_on_id AS dependsOnId
       FROM issue_dependencies
       JOIN issues ON issues.id = issue_dependencies.issue_id
       WHERE issues.project_id = ?
       ORDER BY issue_dependencies.created_at, issue_dependencies.rowid`
    ).all(projectId) as unknown as DependencyEdge[];
  }

  // Direct depends-on neighbors of one issue — the cycle-guard graph step.
  directDependsOn(issueId: string): string[] {
    return (this.db.prepare(
      'SELECT depends_on_id AS id FROM issue_dependencies WHERE issue_id = ?'
    ).all(issueId) as { id: string }[]).map(r => r.id);
  }
}
