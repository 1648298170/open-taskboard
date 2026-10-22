import type { DatabaseSync } from 'node:sqlite';

// 每个 (规范化 server URL, sessionId) 一行的会话保护租约。行永不删除——
// 终态是 released 墓碑，fence 行内单调（F2），一切写绑定 (lease_key, fence)
// 条件（F3），旧 actor 的迟到写全部 no-op。
export interface WakeLeaseRow {
  leaseKey: string;
  sessionId: string;
  serverUrl: string;
  holderRun: string;
  commentId: string | null;
  dispatchId: string | null;
  fence: number;
  state: 'held' | 'dispatching' | 'sent' | 'unverified_sent' | 'released';
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
  dispatchStartedAt: string | null;
}

const COLS = `lease_key AS leaseKey, session_id AS sessionId, server_url AS serverUrl,
  holder_run AS holderRun, comment_id AS commentId, dispatch_id AS dispatchId,
  fence, state, acquired_at AS acquiredAt, renewed_at AS renewedAt,
  expires_at AS expiresAt, dispatch_started_at AS dispatchStartedAt`;

export class WakeLeaseRepo {
  constructor(private db: DatabaseSync) {}

  get(leaseKey: string): WakeLeaseRow | null {
    return (this.db.prepare(`SELECT ${COLS} FROM wake_session_leases WHERE lease_key = ?`).get(leaseKey) ?? null) as unknown as WakeLeaseRow | null;
  }

  findByComment(commentId: string, dispatchId: string): WakeLeaseRow | null {
    return (this.db.prepare(
      `SELECT ${COLS} FROM wake_session_leases WHERE comment_id = ? AND dispatch_id = ? ORDER BY fence DESC LIMIT 1`
    ).get(commentId, dispatchId) ?? null) as unknown as WakeLeaseRow | null;
  }

  /**
   * 新鲜获取 / held 过期接管 / released 新周期（fence+1）。
   * sent/unverified_sent/dispatching 行被 SQL 条件直接拒绝——接管必须先核验。
   */
  acquire(input: {
    leaseKey: string; sessionId: string; serverUrl: string; holderRun: string;
    commentId: string; dispatchId: string; nowIso: string; ttlMs: number;
  }): WakeLeaseRow | null {
    const expires = new Date(Date.parse(input.nowIso) + input.ttlMs).toISOString();
    const result = this.db.prepare(
      `INSERT INTO wake_session_leases
         (lease_key, session_id, server_url, holder_run, comment_id, dispatch_id,
          fence, state, acquired_at, renewed_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'held', ?, ?, ?)
       ON CONFLICT(lease_key) DO UPDATE SET
         holder_run = excluded.holder_run,
         comment_id = excluded.comment_id,
         dispatch_id = excluded.dispatch_id,
         fence = wake_session_leases.fence + 1,
         state = 'held',
         acquired_at = excluded.acquired_at,
         renewed_at = excluded.renewed_at,
         expires_at = excluded.expires_at
       WHERE wake_session_leases.state = 'held' AND wake_session_leases.expires_at <= ?
          OR wake_session_leases.state = 'released'`
    ).run(
      input.leaseKey, input.sessionId, input.serverUrl, input.holderRun, input.commentId,
      input.dispatchId, input.nowIso, input.nowIso, expires, input.nowIso,
    );
    return result.changes > 0 ? this.get(input.leaseKey) : null;
  }

  /** 同 run 同 comment 同活 held 租约的重入续期：fence/state 不变。 */
  renew(input: { leaseKey: string; holderRun: string; commentId: string; dispatchId: string; nowIso: string; ttlMs: number }): boolean {
    const expires = new Date(Date.parse(input.nowIso) + input.ttlMs).toISOString();
    const result = this.db.prepare(
      `UPDATE wake_session_leases SET renewed_at = ?, expires_at = ?
       WHERE lease_key = ? AND holder_run = ? AND comment_id = ? AND dispatch_id = ? AND state = 'held'`
    ).run(input.nowIso, expires, input.leaseKey, input.holderRun, input.commentId, input.dispatchId);
    return result.changes > 0;
  }

  /** 持有者发送前：held → dispatching（I0：任何 POST 之前必须落在此态）。 */
  markDispatching(leaseKey: string, fence: number, dispatchId: string, nowIso: string): boolean {
    const result = this.db.prepare(
      `UPDATE wake_session_leases SET state = 'dispatching', dispatch_started_at = ?
       WHERE lease_key = ? AND fence = ? AND dispatch_id = ? AND state = 'held'`
    ).run(nowIso, leaseKey, fence, dispatchId);
    return result.changes > 0;
  }

  /** POST 得到 2xx（含 204）或结果不明（5xx/超时）→ sent，进入核验语义。 */
  markSent(leaseKey: string, fence: number, dispatchId: string, nowIso: string, ttlMs: number): boolean {
    const expires = new Date(Date.parse(nowIso) + ttlMs).toISOString();
    const result = this.db.prepare(
      `UPDATE wake_session_leases SET state = 'sent', renewed_at = ?, expires_at = ?
       WHERE lease_key = ? AND fence = ? AND dispatch_id = ? AND state = 'dispatching'`
    ).run(nowIso, expires, leaseKey, fence, dispatchId);
    return result.changes > 0;
  }

  /** 发送前 busy/unknown defer：held 未能转 dispatching（没发过请求）→ 释放墓碑。 */
  releaseHeld(leaseKey: string, fence: number, holderRun: string, commentId: string, dispatchId: string): boolean {
    const result = this.db.prepare(
      `UPDATE wake_session_leases SET state = 'released'
       WHERE lease_key = ? AND fence = ? AND holder_run = ? AND comment_id = ?
         AND dispatch_id = ? AND state = 'held'`
    ).run(leaseKey, fence, holderRun, commentId, dispatchId);
    return result.changes > 0;
  }

  /**
   * 核验收尾（结论已落盘后调用）：sent/unverified_sent（或已停滞的 dispatching）
   * → released 墓碑。绑 (fence, dispatch_id)；旧 actor 迟到写 no-op。
   */
  conclude(leaseKey: string, fence: number, dispatchId: string, nowIso: string): boolean {
    const result = this.db.prepare(
      `UPDATE wake_session_leases SET state = 'released', renewed_at = ?
       WHERE lease_key = ? AND fence = ? AND dispatch_id = ?
         AND state IN ('dispatching', 'sent', 'unverified_sent')`
    ).run(nowIso, leaseKey, fence, dispatchId);
    return result.changes > 0;
  }

  /**
   * 运维受控释放（OPS §10）：四元组 + fence 全绑；0 行 → 重读重诊。
   * 仅允许从 sent/unverified_sent 释放（dispatching 行禁止直接释放）。
   */
  opsRelease(leaseKey: string, commentId: string, dispatchId: string, fence: number, nowIso: string): boolean {
    const result = this.db.prepare(
      `UPDATE wake_session_leases SET state = 'released', renewed_at = ?
       WHERE lease_key = ? AND comment_id = ? AND dispatch_id = ? AND fence = ?
         AND state IN ('sent', 'unverified_sent')`
    ).run(nowIso, leaseKey, commentId, dispatchId, fence);
    return result.changes > 0;
  }

  /** 编辑门禁/恢复判定：该轮次是否存在未解除的会话保护。 */
  hasProtection(commentId: string, dispatchId: string): boolean {
    return Boolean(this.db.prepare(
      `SELECT 1 FROM wake_session_leases
        WHERE comment_id = ? AND dispatch_id = ?
          AND state IN ('dispatching', 'sent', 'unverified_sent') LIMIT 1`
    ).get(commentId, dispatchId));
  }
}
