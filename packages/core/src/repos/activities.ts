import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Activity } from '../types.js';

const ACTIVITY_COLS = 'id, issue_id AS issueId, actor, action, detail, created_at AS createdAt';
const now = (): string => new Date().toISOString();
const shortId = (): string => randomUUID().slice(0, 8);

export class ActivityRepo {
  constructor(private db: DatabaseSync) {}

  // Appends one activity row. Caller wraps this in the same transaction as
  // the mutation it describes, so an activity never outlives its change.
  record(issueId: string, actor: string, action: string, detail: string): void {
    this.db.prepare('INSERT INTO activities (id, issue_id, actor, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(shortId(), issueId, actor, action, detail, now());
  }

  listByIssue(issueId: string, limit = 50): Activity[] {
    // rowid tie-breaker: rows created within the same millisecond still come
    // back newest-first (rowid is monotonic insertion order).
    return this.db.prepare(
      `SELECT ${ACTIVITY_COLS} FROM activities WHERE issue_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`
    ).all(issueId, limit) as unknown as Activity[];
  }

  // T6-31: per-actor action counts for a whole project — activities JOIN
  // issues ON issue_id (project filter), one query instead of N+1 per-issue
  // scans. Empty actor rows (anonymous mutations) are excluded; ties break
  // alphabetically so the output is deterministic.
  countByActorForProject(projectId: string, limit = 10): { actor: string; actions: number }[] {
    return this.db.prepare(
      `SELECT a.actor AS actor, COUNT(*) AS actions
         FROM activities a JOIN issues i ON a.issue_id = i.id
        WHERE i.project_id = ? AND a.actor != ''
        GROUP BY a.actor
        ORDER BY actions DESC, actor
        LIMIT ?`
    ).all(projectId, limit) as unknown as { actor: string; actions: number }[];
  }
}
