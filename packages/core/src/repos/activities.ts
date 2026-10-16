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
}
