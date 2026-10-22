import type { DatabaseSync } from 'node:sqlite';

// 引擎存活注册表：心跳决定「死 run」判定，是孤儿回收的唯一所有权证据。
// 行不删除（考古留痕），liveness 由 last_seen_at 新鲜度判定。
export class WakeEngineRepo {
  constructor(private db: DatabaseSync) {}

  /** 启动注册：同 run_id 重复启动（理论不该发生）以最新心跳覆盖。 */
  register(runId: string, kind: string, host: string, pid: number | null, startedAt: string, lastSeenAt: string, version: string): void {
    this.db.prepare(
      `INSERT INTO wake_engines (run_id, kind, host, pid, started_at, last_seen_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         kind = excluded.kind, host = excluded.host, pid = excluded.pid,
         started_at = excluded.started_at, last_seen_at = excluded.last_seen_at, version = excluded.version`
    ).run(runId, kind, host, pid, startedAt, lastSeenAt, version);
  }

  heartbeat(runId: string, lastSeenAt: string): void {
    this.db.prepare('UPDATE wake_engines SET last_seen_at = ? WHERE run_id = ?').run(lastSeenAt, runId);
  }
}
