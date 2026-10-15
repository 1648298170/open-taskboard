import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Comment } from '../types.js';

const COMMENT_COLS = 'id, issue_id AS issueId, author, body, created_at AS createdAt';
const now = (): string => new Date().toISOString();
const shortId = (): string => randomUUID().slice(0, 8);

export class CommentRepo {
  constructor(private db: DatabaseSync) {}

  // Inserts the comment and bumps the parent issue's updated_at.
  // Caller wraps this in a transaction and checks the issue exists first.
  add(issueId: string, input: { author?: string; body: string }): string {
    const id = shortId();
    this.db.prepare('INSERT INTO comments (id, issue_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, issueId, input.author ?? '', input.body, now());
    this.db.prepare('UPDATE issues SET updated_at = ? WHERE id = ?').run(now(), issueId);
    return id;
  }

  get(id: string): Comment | null {
    return this.db.prepare(`SELECT ${COMMENT_COLS} FROM comments WHERE id = ?`).get(id) as unknown as Comment | null;
  }

  list(issueId: string): Comment[] {
    return this.db.prepare(`SELECT ${COMMENT_COLS} FROM comments WHERE issue_id = ? ORDER BY created_at`).all(issueId) as unknown as Comment[];
  }
}
