import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  canTransitionRun,
  type AgentRun,
  type AgentRunEvent,
  type RunSourceType,
  type RunStatus,
  type RunTerminalStatus,
} from '../types.js';

const RUN_COLS = `id AS id, issue_id AS issueId, attempt_no AS attemptNo, previous_run_id AS previousRunId,
  status, source_type AS sourceType, source_comment_id AS sourceCommentId, source_generation AS sourceGeneration,
  idempotency_key AS idempotencyKey, provider_type AS providerType, runtime_id AS runtimeId,
  provider_session_id AS providerSessionId, interaction_mode AS interactionMode,
  prompt_snapshot AS promptSnapshot, result_summary AS resultSummary, error_code AS errorCode,
  error_message AS errorMessage, priority, queued_at AS queuedAt, not_before AS notBefore,
  claimed_by AS claimedBy, claimed_run_id AS claimedRunId, dispatch_id AS dispatchId,
  lease_key AS leaseKey, lease_fence AS leaseFence, workspace_path AS workspacePath,
  worktree_path AS worktreePath, started_at AS startedAt, finished_at AS finishedAt,
  cancel_requested_at AS cancelRequestedAt, exit_code AS exitCode, version,
  created_at AS createdAt, updated_at AS updatedAt`;

const EVENT_COLS = `id, run_id AS runId, event_id AS eventId, sequence, type,
  payload_json AS payloadJson, created_at AS createdAt`;

/** Executable task statuses for Run claiming (mirrors wake eligibility, E1). */
export const RUNNABLE_ISSUE_STATUSES = "('todo', 'in_progress', 'in_review')";

export interface RunTransitionPatch {
  resultSummary?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  exitCode?: number | null;
  providerSessionId?: string | null;
  dispatchId?: string | null;
  notBefore?: string | null;
  startedAt?: string;
  finishedAt?: string;
  cancelRequestedAt?: string | null;
}

export interface RunQueueView {
  view?: 'queued' | 'active' | 'needs_attention' | 'terminal' | 'all';
  status?: RunStatus;
  projectId?: string;
  limit?: number;
  cursor?: string;
}

const VIEW_GROUPS: Record<string, readonly RunStatus[]> = {
  queued: ['queued'],
  active: ['starting', 'running', 'awaiting_input', 'awaiting_approval', 'cancel_requested'],
  needs_attention: ['interrupted'],
  terminal: ['succeeded', 'failed', 'cancelled'],
  all: [],
};

/**
 * Run persistence (Q1). The repo is a thin SQL layer; cross-aggregate
 * preconditions (issue executability, idempotency conflicts, state-machine
 * legality) live in the Store, mirroring the comments/dependencies pattern.
 */
export class RunRepo {
  constructor(private db: DatabaseSync) {}

  create(input: {
    issueId: string;
    attemptNo?: number;
    previousRunId?: string | null;
    sourceType: RunSourceType;
    sourceCommentId?: string | null;
    sourceGeneration?: number | null;
    idempotencyKey: string;
    providerType?: string;
    promptSnapshot: string;
    priority?: number;
    workspacePath?: string;
    worktreePath?: string;
    notBefore?: string | null;
  }): AgentRun {
    const id = randomUUID();
    const t = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO agent_runs (
        id, issue_id, attempt_no, previous_run_id, status, source_type,
        source_comment_id, source_generation, idempotency_key, prompt_snapshot,
        priority, queued_at, not_before, workspace_path, worktree_path,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, input.issueId, input.attemptNo ?? 1, input.previousRunId ?? null,
      input.sourceType, input.sourceCommentId ?? null, input.sourceGeneration ?? null,
      input.idempotencyKey, input.promptSnapshot, input.priority ?? 0, t,
      input.notBefore ?? null, input.workspacePath ?? '', input.worktreePath ?? '', t, t,
    );
    return this.get(id)!;
  }

  get(id: string): AgentRun | null {
    return (this.db.prepare(`SELECT ${RUN_COLS} FROM agent_runs WHERE id = ?`).get(id) ?? null) as unknown as AgentRun | null;
  }

  findByIdempotencyKey(key: string): AgentRun | null {
    return (this.db.prepare(`SELECT ${RUN_COLS} FROM agent_runs WHERE idempotency_key = ?`).get(key) ?? null) as unknown as AgentRun | null;
  }

  /** Per-issue history, newest first, keyset pagination (§7.2). */
  listByIssue(issueId: string, limit: number, cursor?: string): { items: AgentRun[]; cursor: string | null } {
    const params: (string | number)[] = [issueId];
    let where = 'WHERE issue_id = ?';
    if (cursor) {
      const sep = cursor.indexOf('|');
      if (sep > 0) {
        where += ' AND (created_at < ? OR (created_at = ? AND id < ?))';
        params.push(cursor.slice(0, sep), cursor.slice(0, sep), cursor.slice(sep + 1));
      }
    }
    const rows = this.db.prepare(
      `SELECT ${RUN_COLS} FROM agent_runs ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(...params, limit + 1) as unknown as AgentRun[];
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return { items, cursor: hasMore && last ? `${last.createdAt}|${last.id}` : null };
  }

  /** Queue center snapshot (§7.2): filter first, then paginate; counts across view groups. */
  listQueue(nowIso: string, opts: RunQueueView): { items: AgentRun[]; counts: Record<string, number>; cursor: string | null } {
    const counts: Record<string, number> = {};
    for (const [view, statuses] of Object.entries(VIEW_GROUPS)) {
      if (statuses.length === 0) continue;
      const row = this.db.prepare(
        `SELECT COUNT(*) AS n FROM agent_runs WHERE status IN (${statuses.map(() => '?').join(',')})`,
      ).get(...statuses) as { n: number };
      counts[view] = row.n;
    }
    const params: (string | number)[] = [];
    let where = 'WHERE 1=1';
    if (opts.status) {
      where += ' AND status = ?';
      params.push(opts.status);
    } else if (opts.view && opts.view !== 'all') {
      const statuses = VIEW_GROUPS[opts.view];
      if (statuses && statuses.length > 0) {
        where += ` AND status IN (${statuses.map(() => '?').join(',')})`;
        params.push(...statuses);
      }
    }
    if (opts.projectId) {
      where += ' AND issue_id IN (SELECT id FROM issues WHERE project_id = ?)';
      params.push(opts.projectId);
    }
    if (opts.cursor) {
      const sep = opts.cursor.indexOf('|');
      if (sep > 0) {
        where += ' AND (queued_at < ? OR (queued_at = ? AND id < ?))';
        params.push(opts.cursor.slice(0, sep), opts.cursor.slice(0, sep), opts.cursor.slice(sep + 1));
      }
    }
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const rows = this.db.prepare(
      `SELECT ${RUN_COLS} FROM agent_runs ${where} ORDER BY queued_at DESC, id DESC LIMIT ?`,
    ).all(...params, limit + 1) as unknown as AgentRun[];
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return { items, counts, cursor: hasMore && last ? `${last.queuedAt}|${last.id}` : null };
  }

  /**
   * Append a run event with dedupe. Returns null when eventId already exists
   * (idempotent replay); sequence is allocated as max+1 inside the caller's
   * transaction. No stdout/stderr dumps — payloads are size-capped upstream.
   */
  appendEvent(runId: string, eventId: string, type: string, payloadJson: string, nowIso: string): AgentRunEvent | null {
    const dup = this.db.prepare('SELECT 1 AS one FROM agent_run_events WHERE run_id = ? AND event_id = ?').get(runId, eventId);
    if (dup) return null;
    const seqRow = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS seq FROM agent_run_events WHERE run_id = ?').get(runId) as { seq: number };
    const id = randomUUID();
    this.db.prepare(
      'INSERT INTO agent_run_events (id, run_id, event_id, sequence, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, runId, eventId, seqRow.seq, type, payloadJson, nowIso);
    return this.db.prepare(`SELECT ${EVENT_COLS} FROM agent_run_events WHERE id = ?`).get(id) as unknown as AgentRunEvent;
  }

  listEvents(runId: string, afterSequence: number, limit: number): AgentRunEvent[] {
    const capped = Math.max(1, Math.min(limit, 200));
    return this.db.prepare(
      `SELECT ${EVENT_COLS} FROM agent_run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?`,
    ).all(runId, afterSequence, capped) as unknown as AgentRunEvent[];
  }

  /**
   * CAS transition (§4.2): legality is enforced by the Store via
   * canTransitionRun; this UPDATE additionally guards on from-status and
   * version so concurrent actors cannot double-apply. Returns the fresh row,
   * or null when the CAS missed (caller maps to a conflict).
   */
  transition(id: string, fromStatus: RunStatus, to: RunStatus, patch: RunTransitionPatch, nowIso: string): AgentRun | null {
    const current = this.get(id);
    if (!current) return null;
    const sets = ['status = ?', 'version = version + 1', 'updated_at = ?'];
    const vals: (string | number | null)[] = [to, nowIso];
    if (patch.resultSummary !== undefined) { sets.push('result_summary = ?'); vals.push(patch.resultSummary); }
    if (patch.errorCode !== undefined) { sets.push('error_code = ?'); vals.push(patch.errorCode); }
    if (patch.errorMessage !== undefined) { sets.push('error_message = ?'); vals.push(patch.errorMessage); }
    if (patch.exitCode !== undefined) { sets.push('exit_code = ?'); vals.push(patch.exitCode); }
    if (patch.providerSessionId !== undefined) { sets.push('provider_session_id = ?'); vals.push(patch.providerSessionId); }
    if (patch.dispatchId !== undefined) { sets.push('dispatch_id = ?'); vals.push(patch.dispatchId); }
    if (patch.notBefore !== undefined) { sets.push('not_before = ?'); vals.push(patch.notBefore); }
    if (patch.startedAt !== undefined) { sets.push('started_at = ?'); vals.push(patch.startedAt); }
    if (patch.finishedAt !== undefined) { sets.push('finished_at = ?'); vals.push(patch.finishedAt); }
    if (patch.cancelRequestedAt !== undefined) { sets.push('cancel_requested_at = ?'); vals.push(patch.cancelRequestedAt); }
    vals.push(id, fromStatus, current.version);
    const result = this.db.prepare(
      `UPDATE agent_runs SET ${sets.join(', ')} WHERE id = ? AND status = ? AND version = ?`,
    ).run(...vals);
    return result.changes > 0 ? this.get(id) : null;
  }

  /** Claim candidates in effective-priority order (§5.4): priority + aging
   * bonus (capped at +4, one step per 15 min waited) keeps FIFO stable while
   * preventing starvation. Executability is part of the query so archived /
   * done tasks never surface. */
  listClaimCandidates(nowIso: string, max = 25): { id: string; version: number; worktreePath: string; sessionId: string | null }[] {
    return this.db.prepare(
      `SELECT r.id, r.version, r.worktree_path AS worktreePath, p.default_session_id AS sessionId
       FROM agent_runs r
       JOIN issues i ON i.id = r.issue_id
       JOIN projects p ON p.id = i.project_id
       WHERE r.status = 'queued'
         AND (r.not_before IS NULL OR r.not_before <= ?)
         AND i.archived_at IS NULL AND i.status IN ${RUNNABLE_ISSUE_STATUSES}
       ORDER BY (r.priority + MIN(CAST((CAST(strftime('%s', ?) AS INTEGER) - CAST(strftime('%s', r.queued_at) AS INTEGER)) / 900 AS INTEGER), 4)) DESC, r.queued_at ASC, r.rowid ASC
       LIMIT ?`
    ).all(nowIso, nowIso, max) as unknown as { id: string; version: number; worktreePath: string; sessionId: string | null }[];
  }

  /** CAS one candidate to `starting` (caller owns the claim transaction). */
  claimCandidate(input: { id: string; version: number; claimer: string; engineRunId: string; dispatchId: string; sessionId: string | null; nowIso: string }): AgentRun | null {
    const result = this.db.prepare(
      `UPDATE agent_runs SET status = 'starting', claimed_by = ?, claimed_run_id = ?,
         dispatch_id = ?, provider_session_id = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND status = 'queued' AND version = ?`
    ).run(input.claimer, input.engineRunId, input.dispatchId, input.sessionId, input.nowIso, input.id, input.version);
    return result.changes > 0 ? this.get(input.id) : null;
  }

  /** Conflict defer: push not_before out so a busy candidate stops hogging
   * the queue head while other resources keep flowing (§5.4 item 5). */
  deferCandidate(id: string, notBeforeIso: string, nowIso: string): void {
    this.db.prepare(
      `UPDATE agent_runs SET not_before = ?, updated_at = ? WHERE id = ? AND status = 'queued'`
    ).run(notBeforeIso, nowIso, id);
  }

  /** Active runs whose owning engine is gone (§9.4 recovery input). */
  listRunOrphans(livenessCutoffIso: string): AgentRun[] {
    return this.db.prepare(
      `SELECT ${RUN_COLS} FROM agent_runs
       WHERE status IN ('starting', 'running', 'awaiting_input', 'awaiting_approval', 'cancel_requested')
         AND (claimed_run_id IS NULL
              OR claimed_run_id NOT IN (SELECT run_id FROM wake_engines WHERE last_seen_at >= ?))`
    ).all(livenessCutoffIso) as unknown as AgentRun[];
  }

  /** Recovery requeue: pre-dispatch `starting` runs can safely return to the
   * queue — guarded on started_at IS NULL so a run that ever sent stays in
   * the verification path instead (§9.4). */
  requeueUnstarted(id: string, nowIso: string): AgentRun | null {
    const result = this.db.prepare(
      `UPDATE agent_runs SET status = 'queued', claimed_by = '', claimed_run_id = NULL,
         dispatch_id = NULL, version = version + 1, updated_at = ?
       WHERE id = ? AND status = 'starting' AND started_at IS NULL`
    ).run(nowIso, id);
    return result.changes > 0 ? this.get(id) : null;
  }

  countActive(): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS n FROM agent_runs WHERE status IN ('starting', 'running', 'awaiting_input', 'awaiting_approval', 'cancel_requested')",
    ).get() as { n: number };
    return row.n;
  }
}
