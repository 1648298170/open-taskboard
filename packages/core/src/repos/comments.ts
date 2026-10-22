import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Comment, PendingWakeComment } from '../types.js';

// Public comment projection. claimed_by/claimed_run/updated_at/dispatch_id are
// wake-engine CAS state and intentionally stay out of the API payload
// (terminal_at joins the payload only in the S4 contract batch).
const COMMENT_COLS = 'id, issue_id AS issueId, author, body, status, created_at AS createdAt, attempts, last_error AS lastError, not_before AS notBefore, terminal_at AS terminalAt';
const now = (): string => new Date().toISOString();
const shortId = (): string => randomUUID().slice(0, 8);

export interface WakeQueueMeta {
  attempts: number;
  lastError: string;
  notBefore: string | null;
  queuedAt: string | null;
  dispatchId: string | null;
  terminalAt: string | null;
  busySince: string | null;
  busyAccumMs: number;
  absentScans: number;
  queuePriority: number;
  priorityAt: string | null;
}

export class CommentRepo {
  constructor(private db: DatabaseSync) {}

  // Inserts the comment and bumps the parent issue's updated_at.
  // Caller wraps this in a transaction and checks the issue exists first.
  add(issueId: string, input: { author?: string; body: string }): string {
    const id = shortId();
    const t = now();
    this.db.prepare('INSERT INTO comments (id, issue_id, author, body, created_at, updated_at, queued_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, issueId, input.author ?? '', input.body, t, t, t);
    this.db.prepare('UPDATE issues SET updated_at = ? WHERE id = ?').run(t, issueId);
    return id;
  }

  get(id: string): Comment | null {
    // node:sqlite returns undefined for a missing row — normalize to the
    // declared null so callers can rely on the contract.
    return (this.db.prepare(`SELECT ${COMMENT_COLS} FROM comments WHERE id = ?`).get(id) ?? null) as unknown as Comment | null;
  }

  /** 轮次身份：恢复核验与缺席计数都按 (commentId, dispatchId) 精确匹配。 */
  dispatchId(id: string): string | null {
    const row = this.db.prepare('SELECT dispatch_id AS dispatchId FROM comments WHERE id = ?').get(id) as { dispatchId: string | null } | undefined;
    return row?.dispatchId ?? null;
  }

  // Partial update (body/status). Bumps the parent issue's updated_at like
  // add()/delete() do. A status transition also stamps the comment's own
  // updated_at (v21) so status ageing is observable. Caller wraps in a
  // transaction and owns FTS/activity.
  //
  // resetGated（v10 编辑门禁）：当存在未解除的会话保护租约时，编辑只保存正文，
  // 不清空 dispatch_id/terminal_at/attempts/缺席计数——轮次身份必须保留给
  // 迟到核验与受控恢复，否则旧轮证据失焦。
  // 编辑门禁在 Store 层：存在保护租约时只传 body（不传 status），轮次身份与
  // 终态保留给受控恢复；无保护时由调用方附带 status='pending' 触发完整重置。
  update(id: string, patch: { body?: string; status?: string }, issueId: string): void {
    const sets: string[] = [];
    const vals: string[] = [];
    if (patch.body !== undefined) { sets.push('body = ?'); vals.push(patch.body); }
    if (patch.status !== undefined) {
      // An explicit status write ends any engine-owned attempt: the stale
      // claim token must not be able to release a row someone else moved.
      sets.push('status = ?'); vals.push(patch.status);
      sets.push("claimed_by = ''");
      sets.push('claimed_run = NULL');
      sets.push('updated_at = ?'); vals.push(now());
      // 人工重新入队（status → pending）给一次干净的重试：清空退避与失败计数，
      // 否则上次的超时 not_before / attempts 上限会让手动重唤醒无声失效。
      if (patch.status === 'pending') {
        sets.push('attempts = 0', 'not_before = NULL', "last_error = ''", 'terminal_at = NULL', 'dispatch_id = NULL');
        sets.push('queued_at = ?'); vals.push(now());
        // 缺席计数与 busy 窗口同点清零：新轮次从独立计数开始（v9 意见 4）。
        sets.push('absent_scans = 0', 'first_absent_at = NULL', 'last_absent_at = NULL');
        sets.push('busy_since = NULL', 'busy_accum_ms = 0');
        sets.push('queue_priority = 0', 'priority_at = NULL');
      }
    }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE comments SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    this.db.prepare('UPDATE issues SET updated_at = ? WHERE id = ?').run(now(), issueId);
  }

  /**
   * Atomic pending → processing claim. Returns a fresh per-attempt token plus
   * the round identity (dispatch_id), or null when the row was not claimable.
   * v9 门禁：not_before 未到期的行任何领取路径（队列/事件）都不可绕过；
   * terminal_at 非空的评论只能经人工重唤醒（清终态）后进入 claim；
   * 同一 CAS 事务内完成新轮次初始化：dispatch_id 生成 + 缺席计数清零。
   */
  claim(id: string, claimer: string, runId: string): { token: string; dispatchId: string } | null {
    const token = `${claimer}:${randomUUID()}`;
    const dispatchId = randomUUID();
    const t = now();
    const result = this.db.prepare(
      `UPDATE comments
       SET status = 'processing', claimed_by = ?, claimed_run = ?, dispatch_id = ?,
           not_before = NULL, absent_scans = 0, first_absent_at = NULL, last_absent_at = NULL,
           updated_at = ?
       WHERE id = ? AND status = 'pending' AND terminal_at IS NULL AND claimed_by = ''
         AND (not_before IS NULL OR not_before <= ?)`
    ).run(token, runId, dispatchId, t, id, t);
    return Number(result.changes) > 0 ? { token, dispatchId } : null;
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

  /** 队列批次：pending 且已到 not_before、未终态的评论，FIFO（queued_at → created_at → rowid）。 */
  listQueueBatch(nowIso: string): PendingWakeComment[] {
    return this.db.prepare(
      `SELECT c.id, c.issue_id AS issueId, i.project_id AS projectId, i.title AS issueTitle,
              c.author, c.body, c.status, c.created_at AS createdAt
       FROM comments c JOIN issues i ON i.id = c.issue_id
       WHERE c.status = 'pending' AND c.terminal_at IS NULL AND (c.not_before IS NULL OR c.not_before <= ?)
       ORDER BY c.queue_priority DESC,
         CASE WHEN c.queue_priority = 1 THEN c.priority_at END ASC,
         COALESCE(c.queued_at, c.created_at) ASC, c.rowid`
    ).all(nowIso) as unknown as PendingWakeComment[];
  }

  /** 队列元数据（含轮次/终态/busy 字段，供引擎计算等待时长与终局判定）。 */
  queueMeta(id: string): WakeQueueMeta | null {
    return this.db.prepare(
      `SELECT attempts, last_error AS lastError, not_before AS notBefore, queued_at AS queuedAt, status,
              dispatch_id AS dispatchId, terminal_at AS terminalAt,
              busy_since AS busySince, busy_accum_ms AS busyAccumMs,
              absent_scans AS absentScans,
              queue_priority AS queuePriority, priority_at AS priorityAt
       FROM comments WHERE id = ?`
    ).get(id) as unknown as WakeQueueMeta | null;
  }

  /**
   * 投递失败的退避回收：CAS（processing + 认领令牌 + 轮次）→ pending，
   * attempts+1 并记录错误与下次可投时间；busy episode 清零（v5 T6）。
   * terminal=true（达到上限）时同语句写入 terminal_at（人工门禁，无自动重投）。
   */
  requeue(id: string, claimToken: string, dispatchId: string, error: string, notBeforeIso: string, terminal: boolean): boolean {
    const t = now();
    const sets = `status = 'pending', attempts = attempts + 1, last_error = ?,
           not_before = ?, claimed_by = '', claimed_run = NULL,
           busy_since = NULL, busy_accum_ms = 0,
           ${terminal ? 'terminal_at = ?,' : ''} updated_at = ?`;
    const params = terminal ? [error, notBeforeIso, t, t] : [error, notBeforeIso, t];
    const result = this.db.prepare(
      `UPDATE comments SET ${sets}
       WHERE id = ? AND status = 'processing' AND claimed_by = ? AND dispatch_id = ?`
    ).run(...params, id, claimToken, dispatchId);
    return result.changes > 0;
  }

  /**
   * busy defer（确认会话忙）：打开/延续 busy 窗口（COALESCE 防并发重置），
   * 不增加 attempts——这只是等待。轮次绑定同 requeue。
   */
  deferBusy(id: string, claimToken: string, dispatchId: string, notBeforeIso: string): boolean {
    const t = now();
    const result = this.db.prepare(
      `UPDATE comments
       SET status = 'pending', not_before = ?, claimed_by = '', claimed_run = NULL,
           busy_since = COALESCE(busy_since, ?), updated_at = ?
       WHERE id = ? AND status = 'processing' AND claimed_by = ? AND dispatch_id = ?`
    ).run(notBeforeIso, t, t, id, claimToken, dispatchId);
    return result.changes > 0;
  }

  /**
   * unknown defer（探测失败）：关闭并累计 busy 窗口（暂停计时），同轮次绑定。
   * julianday 差值换毫秒；负差（时钟回拨）clamp 到 0。
   */
  deferUnknown(id: string, claimToken: string, dispatchId: string, notBeforeIso: string): boolean {
    const t = now();
    const result = this.db.prepare(
      `UPDATE comments
       SET status = 'pending', not_before = ?, claimed_by = '', claimed_run = NULL,
           busy_accum_ms = busy_accum_ms + CASE WHEN busy_since IS NULL THEN 0
             ELSE MAX(0, CAST((julianday(?) - julianday(busy_since)) * 86400000 AS INTEGER)) END,
           busy_since = NULL, updated_at = ?
       WHERE id = ? AND status = 'processing' AND claimed_by = ? AND dispatch_id = ?`
    ).run(notBeforeIso, t, t, id, claimToken, dispatchId);
    return result.changes > 0;
  }

  /**
   * busy 等待超时：关闭并累计窗口 + 长退避重排，attempts 不变（不是投递失败）。
   */
  deferBusyTimeout(id: string, claimToken: string, dispatchId: string, error: string, notBeforeIso: string): boolean {
    const t = now();
    const result = this.db.prepare(
      `UPDATE comments
       SET status = 'pending', not_before = ?, claimed_by = '', claimed_run = NULL,
           last_error = ?,
           busy_accum_ms = busy_accum_ms + CASE WHEN busy_since IS NULL THEN 0
             ELSE MAX(0, CAST((julianday(?) - julianday(busy_since)) * 86400000 AS INTEGER)) END,
           busy_since = NULL, updated_at = ?
       WHERE id = ? AND status = 'processing' AND claimed_by = ? AND dispatch_id = ?`
    ).run(notBeforeIso, error, t, t, id, claimToken, dispatchId);
    return result.changes > 0;
  }

  /** 发送前确认 idle / 投递成功 / 真实失败：busy episode 结束，双字段清零。 */
  resetBusy(id: string, claimToken: string, dispatchId: string): boolean {
    const result = this.db.prepare(
      `UPDATE comments SET busy_since = NULL, busy_accum_ms = 0, updated_at = ?
       WHERE id = ? AND status = 'processing' AND claimed_by = ? AND dispatch_id = ?`
    ).run(now(), id, claimToken, dispatchId);
    return result.changes > 0;
  }

  /**
   * 人工终态（转人工门禁）：pending + terminal_at + last_error，绝不自动重投。
   * 用于：delivered_unconfirmed、累计缺席达 K、headless 不可核验、结果超时未确认。
   */
  terminalize(id: string, claimToken: string, dispatchId: string, error: string): boolean {
    const result = this.db.prepare(
      `UPDATE comments
       SET status = 'pending', terminal_at = ?, last_error = ?,
           claimed_by = '', claimed_run = NULL,
           busy_since = NULL, busy_accum_ms = 0, updated_at = ?
       WHERE id = ? AND status = 'processing' AND claimed_by = ? AND dispatch_id = ?`
    ).run(now(), error, now(), id, claimToken, dispatchId);
    return result.changes > 0;
  }

  /**
   * 延迟确认完成（v10）：终态评论在其轮次的租约上观察到 assistant+idle 后
   * 转 processed。CAS 绑 (dispatch_id, pending, terminal_at 非空)——旧轮次
   * 观察对新轮次评论必然 no-op。
   */
  completeTerminal(id: string, dispatchId: string): boolean {
    const result = this.db.prepare(
      `UPDATE comments
       SET status = 'processed', terminal_at = NULL, last_error = '', claimed_by = '', updated_at = ?
       WHERE id = ? AND dispatch_id = ? AND status = 'pending' AND terminal_at IS NOT NULL`
    ).run(now(), id, dispatchId);
    return result.changes > 0;
  }

  /**
   * 缺席计数（两步门禁 CAS，v9 意见 2）：
   * 评论侧：dispatch_id + processing + 认领令牌 + terminal_at 守卫 + 5s 门禁；
   * 租约侧：子查询要求 (lease_key, dispatch_id, fence) 未变且处于可核验状态
   * （sent/unverified_sent，或已停滞的 dispatching）。任一失效 → no-op。
   */
  absentScan(id: string, claimToken: string, dispatchId: string, nowIso: string,
             leaseKey: string | null, leaseFence: number | null, staleCutoffIso: string): boolean {
    const result = this.db.prepare(
      `UPDATE comments
       SET absent_scans = absent_scans + 1,
           first_absent_at = COALESCE(first_absent_at, ?),
           last_absent_at = ?
       WHERE id = ? AND dispatch_id = ? AND status = 'processing' AND claimed_by = ?
         AND terminal_at IS NULL
         AND (last_absent_at IS NULL OR last_absent_at <= ?)
         AND (? IS NULL OR EXISTS (
               SELECT 1 FROM wake_session_leases l
                WHERE l.lease_key = ?
                  AND l.dispatch_id = ?
                  AND l.fence = ?
                  AND (l.state IN ('sent','unverified_sent')
                       OR (l.state = 'dispatching' AND l.dispatch_started_at <= ?))))`
    ).run(nowIso, nowIso, id, dispatchId, claimToken, nowIso,
          leaseKey, leaseKey, dispatchId, leaseFence, staleCutoffIso);
    return result.changes > 0;
  }


  /**
   * 队列优先级 CAS 更新（v10 Q1）：仅改 queue_priority/priority_at，
   * 不动 body/attempts/not_before/queued_at/busy/dispatch_id/terminal_at/claimed_by。
   * expected=当前值才执行；当前值已等于目标值 → 幂等 true；不匹配 → false。
   */
  setWakePriority(id: string, expected: number, target: number, nowIso: string): boolean {
    const meta = this.queueMeta(id);
    if (!meta || meta.status !== 'pending' || meta.terminalAt !== null) return false;
    if (meta.queuePriority === target) return true; // 幂等：当前已等于目标
    if (meta.queuePriority !== expected) return false; // CAS 冲突
    const priorityAt = target === 1 ? nowIso : null;
    const result = this.db.prepare(
      `UPDATE comments
       SET queue_priority = ?, priority_at = ?, updated_at = ?
       WHERE id = ? AND queue_priority = ? AND status = 'pending' AND terminal_at IS NULL`
    ).run(target, priorityAt, nowIso, id, expected);
    return result.changes > 0;
  }

  /** 队列修订号递增（须与导致队列变更的写操作同事务调用）。 */
  bumpQueueRevision(): number {
    this.db.prepare(
      `UPDATE app_settings SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'wake_queue_revision'`
    ).run();
    return this.getQueueRevision();
  }

  getQueueRevision(): number {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = 'wake_queue_revision'").get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) || 0 : 0;
  }

  /**
   * 原子选领（v10 Q1 / §15.1）：在调用方的写事务内，按当前排序选取
   * 最高顺序的到期兼容候选，并 CAS claim。候选失配由调用方重读。
   * 返回 null = 无兼容候选。
   */
  claimNextWake(claimer: string, runId: string, nowIso: string, prefix: string, requireBound: boolean):
    { token: string; dispatchId: string; commentId: string; issueId: string; body: string; issueTitle: string } | null {
    const token = `${claimer}:${randomUUID()}`;
    const dispatchId = randomUUID();
    const boundFilter = requireBound ? 'AND p.default_session_id IS NOT NULL' : '';
    const row = this.db.prepare(
      `SELECT c.id AS commentId, c.issue_id AS issueId, c.body,
              i.title AS issueTitle
       FROM comments c
       JOIN issues i ON i.id = c.issue_id
       JOIN projects p ON p.id = i.project_id
       WHERE c.status = 'pending' AND c.terminal_at IS NULL AND c.claimed_by = ''
         AND (c.not_before IS NULL OR c.not_before <= ?)
         AND TRIM(c.body) LIKE ? || '%'
         ${boundFilter}
       ORDER BY c.queue_priority DESC,
                CASE WHEN c.queue_priority = 1 THEN c.priority_at END ASC,
                COALESCE(c.queued_at, c.created_at) ASC, c.id ASC
       LIMIT 1`
    ).get(nowIso, prefix) as { commentId: string; issueId: string; body: string; issueTitle: string } | undefined;
    if (!row) return null;
    const result = this.db.prepare(
      `UPDATE comments
       SET status = 'processing', claimed_by = ?, claimed_run = ?, dispatch_id = ?,
           not_before = NULL, absent_scans = 0, first_absent_at = NULL, last_absent_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'pending' AND terminal_at IS NULL AND claimed_by = ''
         AND (not_before IS NULL OR not_before <= ?)`
    ).run(token, runId, dispatchId, nowIso, row.commentId, nowIso);
    if (result.changes === 0) return null;
    return { token, dispatchId, commentId: row.commentId, issueId: row.issueId, body: row.body, issueTitle: row.issueTitle };
  }

  /**
   * 崩溃恢复关窗（T9）：按指定时刻（行 updated_at）关闭 busy 窗口——
   * 停机时长按 unknown 暂停语义不计入，负差 clamp 0。
   */
  closeBusyAt(id: string, claimToken: string, dispatchId: string, closedAtIso: string): boolean {
    const result = this.db.prepare(
      `UPDATE comments
       SET busy_accum_ms = busy_accum_ms + CASE WHEN busy_since IS NULL THEN 0
             ELSE MAX(0, CAST((julianday(?) - julianday(busy_since)) * 86400000 AS INTEGER)) END,
           busy_since = NULL, updated_at = ?
       WHERE id = ? AND status = 'processing' AND claimed_by = ? AND dispatch_id = ?`
    ).run(closedAtIso, now(), id, claimToken, dispatchId);
    return result.changes > 0;
  }

  /**
   * 结果核对（本 run 专属）：只列本引擎认领、超过超时未更新的 processing 行。
   * inFlight 排除由引擎内存集合负责（不在此查询）。
   */
  listStaleProcessing(cutoffIso: string, runId: string): { id: string; issueId: string; claimToken: string; dispatchId: string | null; updatedAt: string; busySince: string | null }[] {
    return this.db.prepare(
      `SELECT id, issue_id AS issueId, claimed_by AS claimToken, dispatch_id AS dispatchId,
              updated_at AS updatedAt, busy_since AS busySince
       FROM comments
       WHERE status = 'processing' AND updated_at < ? AND claimed_run = ?
       ORDER BY updated_at`
    ).all(cutoffIso, runId) as { id: string; issueId: string; claimToken: string; dispatchId: string | null; updatedAt: string; busySince: string | null }[];
  }

  /**
   * 孤儿扫描（v9/v10 谓词）：只碰「别人」的认领——
   *  · 死 run：claimed_run 非空且注册表心跳过期；
   *  · legacy：claimed_run 为空且年龄超过 24h。
   * 本 run 的认领永远不在此列（结果超时走 listStaleProcessing）。
   * 返回 dispatch_id 供 pre-dispatch 判定与轮次精确核验。
   */
  listOrphanProcessing(graceCutoffIso: string, legacyCutoffIso: string, liveCutoffIso: string, myRun: string):
    { id: string; issueId: string; claimToken: string; dispatchId: string | null; updatedAt: string; busySince: string | null }[] {
    return this.db.prepare(
      `SELECT id, issue_id AS issueId, claimed_by AS claimToken, dispatch_id AS dispatchId,
              updated_at AS updatedAt, busy_since AS busySince
       FROM comments
       WHERE status = 'processing' AND updated_at < ?
         AND (claimed_run IS NULL OR claimed_run <> ?)
         AND (
           (claimed_run IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM wake_engines e
               WHERE e.run_id = comments.claimed_run AND e.last_seen_at >= ?))
           OR (claimed_run IS NULL AND updated_at < ?)
         )
       ORDER BY updated_at`
    ).all(graceCutoffIso, myRun, liveCutoffIso, legacyCutoffIso) as
      { id: string; issueId: string; claimToken: string; dispatchId: string | null; updatedAt: string; busySince: string | null }[];
  }
}
