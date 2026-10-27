import { randomUUID } from 'node:crypto';
import type { AgentRun, RunStatus, Store } from '@taskboard/core';

export interface RunWorkerApi {
  /** Intermediate state moves (starting → running → awaiting_*…). Terminal
   * outcomes come back from execute() and are applied by the scheduler. */
  transition(to: RunStatus, patch?: {
    resultSummary?: string;
    errorCode?: string | null;
    errorMessage?: string | null;
    exitCode?: number | null;
    providerSessionId?: string | null;
  }): void;
  event(type: string, payload?: Record<string, unknown>): void;
}

export interface RunWorkerOutcome {
  status: RunStatus;
  patch?: {
    resultSummary?: string;
    errorCode?: string | null;
    errorMessage?: string | null;
    exitCode?: number | null;
  };
}

export interface RunWorker {
  /** Deterministic failures throw (mapped to `failed`); unknown-outcome
   * timeouts should reject as well — the hard-timeout guard maps those to
   * `interrupted` instead of pretending they failed. */
  execute(run: AgentRun, api: RunWorkerApi): Promise<RunWorkerOutcome>;
  cancel?(run: AgentRun): Promise<'requested' | 'confirmedStopped' | 'unsupported'>;
}

export interface RunSchedulerOptions {
  worker: RunWorker;
  pollMs?: number;
  heartbeatMs?: number;
  concurrency?: number;
  /** Hard cap per execute(); breach maps the run to `interrupted`. */
  executeTimeoutMs?: number;
  host?: string;
  version?: string;
}

export interface RunSchedulerHandle {
  instanceId: string;
  requestPump(): void;
  cancelRun(runId: string): Promise<'cancelled' | 'requested' | 'unsupported' | 'terminal'>;
  recoverOrphans(livenessCutoffMs?: number): { requeued: string[]; interrupted: string[] };
  stop(): void;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The single dispatch-path consumer for agent_runs (Q2). All workers —
 * embedded, sidecar, tests — drive runs through this scheduler; nothing
 * else may move a Run from queued. The in-memory `pumping` flag is only a
 * same-instance reentrancy guard; cross-instance exclusivity is enforced
 * by the claim CAS + session leases in SQLite.
 */
export function startRunScheduler(store: Store, options: RunSchedulerOptions): RunSchedulerHandle {
  const instanceId = `run-scheduler:${randomUUID()}`;
  let stopped = false;
  let pumping = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const startedAt = new Date().toISOString();
  store.registerWakeEngine(instanceId, 'run-scheduler', options.host ?? 'local', process.pid ?? null, startedAt, startedAt, options.version ?? '0.3.0');

  function requestPump(): void {
    void pump();
  }

  async function executeClaimed(claimed: AgentRun): Promise<void> {
    let seq = 0;
    const nowIso = (): string => new Date().toISOString();
    const api: RunWorkerApi = {
      transition(to, patch) {
        const stamp = to === 'running' ? { startedAt: nowIso() } : {};
        store.transitionRun(claimed.id, to, { ...stamp, ...(patch ?? {}) });
        store.appendRunEvent(claimed.id, `evt-${randomUUID()}`, to, { by: instanceId, ...(patch ?? {}) });
      },
      event(type, payload) {
        store.appendRunEvent(claimed.id, `evt-${randomUUID()}`, type, { seq: seq++, ...(payload ?? {}) });
      },
    };
    const isTerminalStatus = (st: RunStatus): boolean =>
      st === 'succeeded' || st === 'failed' || st === 'cancelled';
    // a run cancelled by the user mid-flight keeps its terminal state;
    // late worker outcomes (and their error paths) must be discarded
    const applyFinal = (status: RunStatus, patch: {
      resultSummary?: string;
      errorCode?: string | null;
      errorMessage?: string | null;
      exitCode?: number | null;
    } = {}): void => {
      const cur = store.getAgentRun(claimed.id);
      if (!cur || isTerminalStatus(cur.status)) return;
      try {
        // auto-collapse: a fast worker may return succeeded without an
        // intermediate running transition — its successful outcome IS the
        // completion evidence, so stamp running (startedAt) first
        if (status === 'succeeded' && cur.status === 'starting') {
          store.transitionRun(claimed.id, 'running', { startedAt: nowIso() });
          store.appendRunEvent(claimed.id, `evt-${randomUUID()}`, 'running', { by: instanceId, auto: true });
        }
        const terminal = isTerminalStatus(status);
        const stamp = terminal ? { finishedAt: nowIso() } : {};
        store.transitionRun(claimed.id, status, { ...stamp, ...patch });
        store.appendRunEvent(claimed.id, `evt-${randomUUID()}`, status, { by: instanceId });
      } catch (err) {
        const cur2 = store.getAgentRun(claimed.id);
        if (!cur2 || isTerminalStatus(cur2.status)) return;
        store.transitionRun(claimed.id, 'failed', {
          errorCode: 'WORKER_ERROR',
          errorMessage: `illegal worker outcome ${status}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
        });
      }
    };
    try {
      const outcome = await withTimeout(
        options.worker.execute(claimed, api),
        options.executeTimeoutMs,
      );
      applyFinal(outcome.status, { ...(outcome.patch ?? {}) });
    } catch (err) {
      const timedOut = err instanceof WorkerTimeoutError;
      applyFinal(
        timedOut ? 'interrupted' : 'failed',
        timedOut
          ? { errorCode: 'RUNTIME_UNAVAILABLE', errorMessage: 'worker execute timed out; dispatch result unknown' }
          : { errorCode: 'WORKER_ERROR', errorMessage: `${err instanceof Error ? err.message : String(err)}`.slice(0, 500) },
      );
      store.appendRunEvent(claimed.id, `evt-${randomUUID()}`, timedOut ? 'interrupted' : 'failed', { by: instanceId });
    } finally {
      if (claimed.dispatchId) store.releaseAgentRunLease(claimed.id, claimed.dispatchId);
    }
  }

  async function pump(): Promise<void> {
    if (pumping || stopped) return;
    pumping = true;
    try {
      while (!stopped) {
        const claimed = store.claimNextAgentRun(instanceId, instanceId, { globalLimit: options.concurrency });
        if (!claimed) break;
        await executeClaimed(claimed);
      }
    } finally {
      pumping = false;
    }
  }

  function recoverOrphans(livenessCutoffMs = 90_000): { requeued: string[]; interrupted: string[] } {
    const cutoff = new Date(Date.now() - livenessCutoffMs).toISOString();
    const result = store.recoverOrphanRuns(cutoff);
    if (result.requeued.length > 0 || result.interrupted.length > 0) requestPump();
    return result;
  }

  async function cancelRun(runId: string): Promise<'cancelled' | 'requested' | 'unsupported' | 'terminal'> {
    const run = store.getAgentRun(runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') return 'terminal';
    if (run.status === 'queued') {
      store.transitionRun(runId, 'cancelled');
      return 'cancelled';
    }
    if (!options.worker.cancel) return 'unsupported';
    const result = await options.worker.cancel(run);
    if (result === 'confirmedStopped') {
      store.transitionRun(runId, 'cancelled');
      return 'cancelled';
    }
    if (result === 'requested') {
      if (run.status !== 'cancel_requested') store.transitionRun(runId, 'cancel_requested');
      return 'requested';
    }
    return 'unsupported';
  }

  heartbeatTimer = setInterval(() => { if (!stopped) store.heartbeatWakeEngine(instanceId, new Date().toISOString()); }, options.heartbeatMs ?? 30_000);
  heartbeatTimer.unref?.();
  pollTimer = setInterval(() => { if (!stopped) requestPump(); }, Math.max(options.pollMs ?? 30_000, 1_000));
  pollTimer.unref?.();

  recoverOrphans();
  requestPump();

  return {
    instanceId,
    requestPump,
    cancelRun,
    recoverOrphans,
    stop() {
      stopped = true;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    },
  };
}

class WorkerTimeoutError extends Error {
  constructor() { super('worker execute timed out'); }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new WorkerTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error('waitFor: condition not met within timeout');
}
