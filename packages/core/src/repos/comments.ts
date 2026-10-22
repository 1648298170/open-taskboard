import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Comment, PendingWakeComment } from '../types.js';

// Public comment projection. claimed_by/updated_at are wake-engine CAS state
// (v21) and intentionally stay out of the API payload.
const COMMENT_COLS = 'id, issue_id AS issueId, author, body, status, created_at AS createdAt';
const now = (): string => new Date().toISOString();
const shortId = (): string => randomUUID().slice(0, 8);

export class CommentRepo {
  constructor(private db: DatabaseSync) {}

  // Inserts the comment and bumps the parent issue's updated_at.
  // Caller wraps this in a transaction and checks the issue exists first.
  add(issueId: string, input: { author?: string; body: string }): string {
    const id = shortId();
    const t = now();
    this.db.prepare('INSERT INTO comments (id, issue_id, author, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, issueId, input.author ?? '', input.body, t, t);
    this.db.prepare('UPDATE issues SET updated_at = ? WHERE id = ?').run(t, issueId);
    return id;
  }

  get(id: string): Comment | null {
    // node:sqlite returns undefined for a missing row — normalize to the
    // declared null so callers can rely on the contract.
    return (this.db.prepare(`SELECT ${COMMENT_COLS} FROM comments WHERE id = ?`).get(id) ?? null) as unknown as Comment | null;
  }

  // Partial update (body/status). Bumps the parent issue's updated_at like
  // add()/delete() do. A status transition also stamps the comment's own
  // updated_at (v21) so status ageing is observable. Caller wraps in a
  // transaction and owns FTS/activity.
  update(id: string, patch: { body?: string; status?: string }, issueId: string): void {
    const sets: string[] = [];
    const vals: string[] = [];
    if (patch.body !== undefined) { sets.push('body = ?'); vals.push(patch.body); }
    if (patch.status !== undefined) {
      // An explicit status write ends any engine-owned attempt: the stale
      // claim token must not be able to release a row someone else moved.
      sets.push('status = ?'); vals.push(patch.status);
      sets.push("claimed_by = ''");
      sets.push('updated_at = ?'); vals.push(now());
    }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE comments SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    this.db.prepare('UPDATE issues SET updated_at = ? WHERE id = ?').run(now(), issueId);
  }

  /**
   * Atomic pending → processing claim. Returns a fresh per-attempt token, or
   * null when the row was not pending. The token is stored in claimed_by: that
   * column is the CAS guard for release(), so a stale attempt can never revert
   * a newer claim (ABA-safe).
   */
  claim(id: string, claimer: string): string | null {
    const token = `${claimer}:${randomUUID()}`;
    const result = this.db.prepare(
      "UPDATE comments SET status = 'processing', claimed_by = ?, updated_at = ? WHERE id = ? AND status = 'pending'"
    ).run(token, now(), id);
    return Number(result.changes) > 0 ? token : null;
  }

  /**
   * CAS release: only the attempt holding the exact token may move the row.
   * nextStatus 'pending' reverts a failed delivery, 'processed' finalizes a
   * headless run. Returns whether the row actually moved.
   */
  release(id: string, claimToken: string, nextStatus: 'pending' | 'processed'): boolean {
    const result = this.db.prepare(
      "UPDATE comments SET status = ?, claimed_by = '', updated_at = ? WHERE id = ? AND status = 'processing' AND claimed_by = ?"
    ).run(nextStatus, now(), id, claimToken);
    return Number(result.changes) > 0;
  }

  /** Startup sweep: every pending comment joined with its issue (tiny set). */
  listPending(): PendingWakeComment[] {
    return this.db.prepare(
      `SELECT c.id, c.issue_id AS issueId, i.project_id AS projectId, i.title AS issueTitle,
              c.author, c.body, c.status, c.created_at AS createdAt
       FROM comments c JOIN issues i ON i.id = c.issue_id
       WHERE c.status = 'pending'
       ORDER BY c.created_at, c.rowid`
    ).all() as unknown as PendingWakeComment[];
  }

  countByAuthor(issueId: string, author: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM comments WHERE issue_id = ? AND author = ?').get(issueId, author) as { n: number }).n;
  }

  list(issueId: string): Comment[] {
    return this.db.prepare(`SELECT ${COMMENT_COLS} FROM comments WHERE issue_id = ? ORDER BY created_at, rowid`).all(issueId) as unknown as Comment[];
  }

  // Deletes one comment and touches the parent issue's updated_at — the exact
  // mirror of add(). Caller wraps this in a transaction and owns FTS cleanup,
  // activity and events.
  delete(id: string, issueId: string): void {
    this.db.prepare('DELETE FROM comments WHERE id = ?').run(id);
    this.db.prepare('UPDATE issues SET updated_at = ? WHERE id = ?').run(now(), issueId);
  }

  /** 队列批次：pending 且已到 not_before 的评论，FIFO（queued_at → created_at → rowid）。 */
  listQueueBatch(nowIso: string): PendingWakeComment[] {
    return this.db.prepare(
      `SELECT c.id, c.issue_id AS issueId, i.project_id AS projectId, i.title AS issueTitle,
              c.author, c.body, c.status, c.created_at AS createdAt
       FROM comments c JOIN issues i ON i.id = c.issue_id
       WHERE c.status = 'pending' AND (c.not_before IS NULL OR c.not_before <= ?)
       ORDER BY COALESCE(c.queued_at, c.created_at), c.rowid`
    ).all(nowIso) as unknown as PendingWakeComment[];
  }

  /** 队列元数据（attempts / lastError / notBefore / queuedAt）。 */
  queueMeta(id: string): { attempts: number; lastError: string; notBefore: string | null; queuedAt: string | null } | null {
    return this.db.prepare(
      'SELECT attempts, last_error AS lastError, not_before AS notBefore, queued_at AS queuedAt FROM comments WHERE id = ?'
    ).get(id) as { attempts: number; lastError: string; notBefore: string | null; queuedAt: string | null } | null;
  }

  /** 投递失败的退避回收：CAS（processing + 认领令牌）→ pending，attempts+1 并记录错误与下次可投时间。 */
  requeue(id: string, claimToken: string, error: string, notBeforeIso: string): boolean {
    const result = this.db.prepare(
      `UPDATE comments
       SET status = 'pending', attempts = attempts + 1, last_error = ?,
           not_before = ?, claimed_by = '', updated_at = ?
       WHERE id = ? AND status = 'processing' AND claimed_by = ?`
    ).run(error, notBeforeIso, now(), id, claimToken);
    return result.changes > 0;
  }

  /**
   * 执行通道互斥的延后：会话 busy 时把评论放回队列（不增加 attempts——这不是
   * 失败，只是等待空闲）。CAS 同上，令牌失效则返回 false。
   */
  defer(id: string, claimToken: string, notBeforeIso: string): boolean {
    const result = this.db.prepare(
      `UPDATE comments
       SET status = 'pending', not_before = ?, claimed_by = '', updated_at = ?
       WHERE id = ? AND status = 'processing' AND claimed_by = ?`
    ).run(notBeforeIso, now(), id, claimToken);
    return result.changes > 0;
  }
}
