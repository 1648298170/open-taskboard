// Wake-delivery engine. Phase 1 keeps the exact external-sidecar behavior:
// subscribe to Store events for latency, sweep pending comments once at start,
// then deliver wakes through a serialized queue. Every delivery first claims
// the comment with a per-attempt CAS token, so duplicate sidecars (and the
// phase-2 embedded engine) can never inject the same wake twice.
//
// Delivery still talks to OpenCode/TUI over HTTP; the board itself is read and
// written through the injected Store — the engine no longer calls the board
// REST API for issue loading, status marking, or execution events.

import * as path from 'node:path';
import type { Store, StoreEvent } from '@taskboard/core';
import { isWakeComment } from '@taskboard/core';
import { fetchWithTimeout, WATCH_REQUEST_TIMEOUT_MS, type FetchLike } from './fetch.js';
import { acquireWatchLock } from './lock.js';
import {
  buildWakePrompt,
  channelFor,
  decideWake,
  findCorrelatedAssistant,
  isIgnoredAuthor,
  sessionBaseCandidates,
  shouldWake,
  wakeKey,
  wantsProject,
} from './prompt.js';

/** The Store slice the engine depends on (the facade itself satisfies it). */
export type WakeStore = Pick<
  Store,
  'claimWake' | 'releaseWake' | 'getComment' | 'getIssue' | 'listQueueBatch' | 'queueMeta' | 'requeueWake' | 'deferWakeBusy' | 'deferWakeUnknown' | 'deferBusyTimeout' | 'resetBusy' | 'terminalizeWake' | 'completeTerminalWake' | 'absentScan' | 'listStaleProcessing' | 'listOrphanProcessing' | 'recordExecutionEvent' | 'subscribe' | 'registerWakeEngine' | 'heartbeatWakeEngine' | 'wakeLeaseAcquire' | 'wakeLeaseRenew' | 'wakeLeaseMarkDispatching' | 'wakeLeaseMarkSent' | 'wakeLeaseReleaseHeld' | 'wakeLeaseConclude' | 'wakeLeaseGet' | 'wakeLeaseFindByComment' | 'wakeLeaseHasProtection'
>;

/** Narrow child-process surface so tests can inject a deterministic spawn. */
/** 共享常量：唤醒投递的最大自动重试次数（含首次）。达上限转人工终态。 */
export const WAKE_MAX_ATTEMPTS = 5;

export interface WakeChildProcess {
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}
export type SpawnFn = (command: string, args: string[], options: { stdio: 'inherit' }) => WakeChildProcess;

export interface WakeEngineConfig {
  /** Wake comment prefix (default @agent). */
  prefix: string;
  /** Explicit OpenCode base (--opencode / deployment env). */
  opencodeBase?: string;
  /** TUI base for unbound tasks (--tui-url fallback). */
  tuiBase?: string;
  /**
   * Headless command split on spaces (default `opencode run`). Omit it in the
   * embedded server engine: spawning a brand-new agent session is an
   * external-sidecar capability, so an unbound task must fail closed instead.
   */
  execParts?: string[];
  /** Explicit model id; falls back to env.OPENCODE_MODEL. */
  model?: string;
  /** Optional project scope (--project). */
  projectFilter?: string;
  /** Actor names that must not wake themselves; always contains 'watch'. */
  ignoreAuthors: ReadonlySet<string>;
}

export interface WakeDeps {
  store: WakeStore;
  fetchImpl: FetchLike;
  spawn: SpawnFn;
  randomUUID: () => string;
  homedir: () => string;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** Single sink: level 'error' maps to stderr in the CLI wrapper. */
  log: (message: string, level?: 'info' | 'error') => void;
  requestTimeoutMs: number;
  config: WakeEngineConfig;
}

export interface WakeEngineOptions {
  /**
   * External-mode lock file name (e.g. `watch-47824-all.lock`). When present
   * the engine acquires ~/.taskboard/<lockKey> and refuses a second instance;
   * when absent (embedded phase 2) it skips locking entirely.
   */
  lockKey?: string;
  /**
   * Durability trigger for the embedded engine: run the same startup sweep
   * every `pollMs` milliseconds. It deliberately reuses `sweep()` → `enqueue`,
   * so the serialized delivery queue stays the single execution path and an
   * event-driven wake can never race a polled one. Event subscription stays
   * for latency; this poll is the safety net that removes silent backlogs.
   * Undefined (external sidecar) means no timer at all.
   */
  pollMs?: number;
  /**
   * 执行通道互斥的等待时长（毫秒）：目标会话 busy 时把评论放回队列并设置
   * not_before，等 agent 当前轮次结束后再投。默认 30s。
   */
  busyDeferMs?: number;
  /**
   * busy 等待上限（毫秒）：从首次确认 busy 起累计（busy_since/busy_accum_ms），
   * 超过后 +24h 纯重排（不耗 attempts）。默认 2 小时。
   */
  busyMaxWaitMs?: number;
  /** 指数退避的基数与上限（毫秒）。默 30s 起 10min 封顶。 */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** 结果核对超时（毫秒）。默认 10min。 */
  resultTimeoutMs?: number;
  /** 引擎心跳间隔（毫秒）：注册表 liveness 的依据。默认 30s，timer unref。 */
  heartbeatMs?: number;
  /** dispatching 态停滞阈值（毫秒）：超过后其他引擎才可对其核验。默认 90s。 */
  dispatchStaleMs?: number;
  /** 注册表里的引擎种类（embedded / sidecar），仅诊断用。 */
  kind?: string;
}

export interface WakeEngine {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
}

type ExecutionOutcome = 'started' | 'queued' | 'running' | 'idle' | 'retrying' | 'succeeded' | 'failed';

interface WakeItem {
  issueId: string;
  commentId: string;
  issueTitle: string;
  instruction: string;
  author?: string;
  key: string;
  source: 'event' | 'backfill';
}

export function createWakeEngine(deps: WakeDeps, options: WakeEngineOptions = {}): WakeEngine {
  const { store, config } = deps;
  const log = (message: string): void => deps.log(message);
  const error = (message: string): void => deps.log(message, 'error');

  const model = (config.model ?? deps.env.OPENCODE_MODEL ?? '').trim();
  const modelArgs = model ? ['-m', model] : [];
  // v1 prompt_async accepts an explicit model override; only `provider/model`
  // ids can be split into the v1 {providerID, modelID} shape.
  const [modelProvider, ...modelRest] = model.split('/');
  const modelRef = modelRest.length > 0
    ? { providerID: modelProvider!, modelID: modelRest.join('/') }
    : undefined;
  // Run identity: registry heartbeats and claim ownership are keyed by this.
  const runId = deps.randomUUID();

  let running = false;
  let unsubscribe: (() => void) | null = null;
  let releaseLock: (() => void) | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let orphanTimer: ReturnType<typeof setInterval> | null = null;
  // Channel-level watchdog state: one WARN while OpenCode is unreachable, one
  // RECOVERED line when it returns. Pending comments are retried by the sweep
  // either way; these lines are the operator's early signal.
  let channelDown = false;
  let probeInFlight = false;
  let queue: Promise<void> = Promise.resolve();
  let lifecycle = new AbortController();
  const seen = new Set<string>();
  const monitoredSessions = new Set<string>();
  // busy 延后的活动流节流：同一评论 10 分钟内只记一条「已排队」活动。
  const busyDeferReportedAt = new Map<string, number>();
  // Comments this engine can never deliver (no binding, no unbound channel).
  // They stay pending for an external sidecar; log once instead of every poll.
  const parked = new Set<string>();
  // 本次投递动作在途的评论：结果超时扫描必须跳过，防止误回收活动任务。
  const inFlight = new Set<string>();

  const request = (input: string | URL, init: RequestInit = {}, timeoutMs = deps.requestTimeoutMs): Promise<Response> =>
    fetchWithTimeout(input, init, timeoutMs, deps.fetchImpl);

  const sleep = (ms: number): Promise<void> => new Promise(resolve => {
    const done = (): void => {
      clearTimeout(timer);
      lifecycle.signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    lifecycle.signal.addEventListener('abort', done, { once: true });
  });

  /** Probe candidates in order; a stale --opencode URL must not pin the queue. */
  const firstHealthySessionBase = async (candidates: readonly string[]): Promise<string | undefined> => {
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]!;
      try {
        const response = await request(`${candidate}/global/health`, { headers: { accept: 'application/json' } }, 2_000);
        await response.arrayBuffer();
        if (!response.ok) {
          error(`watch: OpenCode health check failed (${candidate}, HTTP ${response.status})`);
          continue;
        }
        if (i > 0) {
          error(`watch: preferred OpenCode endpoint is unavailable; using reachable fallback ${candidate}`);
        }
        return candidate;
      } catch (err) {
        error(`watch: OpenCode health check failed (${candidate}: ${(err as Error).message})`);
      }
    }
    return undefined;
  };

  /**
   * GET /session/status → 三态。type missing 视为 idle（活跃会话才出现在映射里），
   * 无法识别的非空 type / HTTP 错误 / 非法载荷 / 异常一律 unknown（fail-closed：
   * 调用方 defer，不投递也不回收）。
   */
  const sessionState = async (base: string, sessionId: string, directory: string): Promise<'busy' | 'idle' | 'unknown'> => {
    try {
      const url = new URL(`${base}/session/status`);
      if (directory) url.searchParams.set('directory', directory);
      const response = await request(url.toString(), { headers: { accept: 'application/json' } }, 3_000);
      if (!response.ok) {
        error(`watch: WARN session status probe returned HTTP ${response.status}; treating as unknown`);
        return 'unknown';
      }
      const payload = await response.json() as unknown;
      if (typeof payload !== 'object' || payload === null) return 'unknown';
      const raw = (payload as Record<string, unknown>)[sessionId];
      const type = raw && typeof raw === 'object' && typeof (raw as { type?: unknown }).type === 'string'
        ? (raw as { type: string }).type
        : '';
      if (type === 'busy' || type === 'running' || type === 'retry') return 'busy';
      if (type === 'idle' || type === '') return 'idle';
      return 'unknown';
    } catch (err) {
      error(`watch: WARN session status probe failed (${(err as Error).message}); treating as unknown`);
      return 'unknown';
    }
  };

  /**
   * 结果核对单行处理（结果超时 + 孤儿扫描共用）：
   *  pre-dispatch（无 dispatching/sent/unverified_sent 租约）→ I0 自动回收；
   *  post-dispatch → probe=idle 前置 + 精确轮次 marker 核验四态。
   */
  const resolveStaleRow = async (issueId: string, commentId: string, claimToken: string,
    dispatchId: string | null, timeoutMs: number): Promise<void> => {
    const postDispatch = dispatchId != null && store.wakeLeaseHasProtection(commentId, dispatchId);
    if (!postDispatch) {
      // I0：发送前中断——回收为 pending（attempts 保留），无证据租约由 TTL 惰性失效。
      if (store.releaseWake(commentId, claimToken, 'pending')) {
        await reportExecution(issueId, 'queued', '发送前中断，已自动恢复（不消耗重试预算）');
      }
      return;
    }
    const issue = store.getIssue(issueId);
    const base = config.opencodeBase?.trim();
    if (issue?.sessionId) {
      if (!base) return;
      const st = await sessionState(base, issue.sessionId, issue.worktreePath);
      if (st !== 'idle') return;
      const marker = makeWakeCorrelationMarker(commentId, dispatchId);
      const hist = await request(`${base}/session/${encodeURIComponent(issue.sessionId)}/message?limit=50`);
      if (!hist.ok) return;
      const correlation = findCorrelatedAssistant(await hist.json(), marker);
      if (correlation.assistant) {
        const err = correlation.assistant.info?.error;
        if (store.releaseWake(commentId, claimToken, 'processed')) {
          const lease = dispatchId ? store.wakeLeaseFindByComment(commentId, dispatchId) : null;
          if (lease) store.wakeLeaseConclude(lease.leaseKey, lease.fence, dispatchId, nowIso());
          await reportExecution(issueId, err ? 'failed' : 'succeeded',
            err ? `恢复核验：Agent 返回错误：${String(err).slice(0, 500)}`
                : '恢复核验：已确认完成（marker + assistant 回复 + idle）');
        }
        return;
      }
      if (correlation.matchedPrompt) {
        if (store.terminalizeWake(commentId, claimToken, dispatchId ?? '', '已送达但未确认完成（无 assistant 回复）；人工确认后重新唤醒')) {
          await reportExecution(issueId, 'failed', '已送达但未确认完成，转人工确认');
        }
        return;
      }
      // 缺席：累计有效观察（达 K → 人工终态）
      const counted = store.absentScan(commentId, claimToken, dispatchId ?? '', nowIso(), null, null, new Date(Date.now() - timeoutMs).toISOString());
      if (counted) {
        const meta = store.queueMeta(commentId);
        if ((meta?.absentScans ?? 0) >= 3) {
          if (store.terminalizeWake(commentId, claimToken, dispatchId ?? '', `投递结果无法确认（累计有效缺席 ${meta?.absentScans} 次）；人工确认后重新唤醒`)) {
            await reportExecution(issueId, 'failed', '投递结果无法确认（缺席核验达上限），转人工确认');
          }
        }
      }
      return;
    }
    // 无 Session（headless/TUI）且已 post-dispatch：不可核验 → 人工终态
    if (store.terminalizeWake(commentId, claimToken, dispatchId ?? '', 'headless 执行无法核验（引擎中断）；人工确认后重新唤醒')) {
      await reportExecution(issueId, 'failed', 'headless 执行无法核验（引擎中断），转人工确认');
    }
  };

  const sweepStaleProcessing = async (): Promise<void> => {
    if (!running) return;
    const timeoutMs = options.resultTimeoutMs ?? 10 * 60_000;
    const cutoffIso = new Date(Date.now() - timeoutMs).toISOString();
    let stale: { id: string; issueId: string; claimToken: string; dispatchId: string | null }[] = [];
    try {
      stale = store.listStaleProcessing(cutoffIso, runId);
    } catch (err) {
      error(`watch: stale processing scan failed (${(err as Error).message})`);
      return;
    }
    for (const row of stale) {
      if (!running) return;
      if (inFlight.has(row.id)) continue;
      try {
        await resolveStaleRow(row.issueId, row.id, row.claimToken, row.dispatchId, timeoutMs);
      } catch (err) {
        error(`watch: stale processing recovery failed for comment ${row.id} (${(err as Error).message})`);
      }
    }
  };

  /** 孤儿扫描（启动 + 每 5 分钟）：死 run / legacy；本 run 永不在此列。 */
  const sweepOrphans = async (): Promise<void> => {
    if (!running) return;
    const hb = options.heartbeatMs ?? 30_000;
    const liveCutoff = new Date(Date.now() - Math.max(3 * hb, 180_000)).toISOString();
    const graceCutoff = new Date(Date.now() - 60_000).toISOString();
    const legacyCutoff = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    let rows: { id: string; issueId: string; claimToken: string; dispatchId: string | null }[] = [];
    try {
      rows = store.listOrphanProcessing(graceCutoff, legacyCutoff, liveCutoff, runId);
    } catch (err) {
      error(`watch: orphan scan failed (${(err as Error).message})`);
      return;
    }
    for (const row of rows) {
      if (!running) return;
      try {
        await resolveStaleRow(row.issueId, row.id, row.claimToken, row.dispatchId, options.resultTimeoutMs ?? 10 * 60_000);
      } catch (err) {
        error(`watch: orphan recovery failed for comment ${row.id} (${(err as Error).message})`);
      }
    }
  };

  const reportExecution = async (issueId: string, outcome: ExecutionOutcome, detail: string): Promise<void> => {
    try {
      store.recordExecutionEvent(issueId, outcome, detail, 'watch');
    } catch (err) {
      error(`watch: execution event report failed (${(err as Error).message})`);
    }
  };

  // OpenCode prompt_async acknowledges only queueing. A unique marker lets us
  // find the exact user message in the Session history; success requires a
  // later assistant response AND the Session returning to idle.
  const nowIso = (): string => new Date().toISOString();
  const LEASE_TTL_MS = 120_000;
  const LEASE_VERIFY_TTL_MS = 10 * 60_000;
  const normalizeLeaseBase = (base: string): string => {
    try { const u = new URL(base); return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`; }
    catch { return base.trim().replace(/\/+$/, ''); }
  };
  const makeWakeCorrelationMarker = (commentId: string, dispatchId: string | null): string =>
    `taskboard-wake:${commentId || 'unknown'}:${dispatchId || 'none'}`;

  const monitorOpenCodeSession = async (
    issueId: string, sessionId: string, serverUrl: string, marker: string,
  ): Promise<void> => {
    const monitorKey = `${sessionId}:${marker}`;
    if (monitoredSessions.has(monitorKey)) return;
    monitoredSessions.add(monitorKey);
    let observedBusy = false;
    let reportedRunning = false;
    let matchedPrompt = false;
    const deadline = Date.now() + 10 * 60_000;
    try {
      while (running && Date.now() < deadline) {
        await sleep(2_000);
        if (!running) return;
        const [statusResponse, messagesResponse] = await Promise.all([
          request(`${serverUrl}/session/status`),
          request(`${serverUrl}/session/${encodeURIComponent(sessionId)}/message?limit=50`),
        ]);
        if (!statusResponse.ok) throw new Error(`OpenCode status returned HTTP ${statusResponse.status}`);
        if (!messagesResponse.ok) throw new Error(`OpenCode message history returned HTTP ${messagesResponse.status}`);
        const statusPayload = await statusResponse.json() as Record<string, unknown>;
        const rawStatus = statusPayload && typeof statusPayload === 'object' ? statusPayload[sessionId] : undefined;
        const status = rawStatus && typeof rawStatus === 'object' && 'type' in rawStatus
          ? String((rawStatus as { type: unknown }).type)
          : '';
        const rawMessages = await messagesResponse.json() as unknown;
        const correlation = findCorrelatedAssistant(rawMessages, marker);
        if (correlation.matchedPrompt) matchedPrompt = true;
        const assistant = correlation.assistant;

        if (status === 'busy' || status === 'retry') {
          observedBusy = true;
          if (matchedPrompt && !reportedRunning) {
            reportedRunning = true;
            await reportExecution(issueId, 'running',
              `已在 OpenCode Session ${sessionId} 历史中匹配到本次唤醒；当前会话处于执行状态`);
          }
        }
        if (assistant && status === 'idle') {
          const failure = assistant.info?.error;
          if (failure) {
            const detail = typeof failure === 'string' ? failure : JSON.stringify(failure);
            await reportExecution(issueId, 'failed',
              `OpenCode 已返回与本次唤醒关联的 Assistant 错误：${detail.slice(0, 1500)}`);
          } else {
            await reportExecution(issueId, 'succeeded',
              `已匹配本次唤醒标识 ${marker}，并观察到后续 Assistant 回复且 Session 已空闲`);
          }
          return;
        }
        if (status === 'idle' && observedBusy && matchedPrompt && !assistant) {
          // A busy→idle transition without a correlated assistant reply is not proof of success.
          await reportExecution(issueId, 'idle',
            `Session ${sessionId} 已空闲，但尚未找到本次唤醒对应的 Assistant 回复；不判定任务成功`);
          observedBusy = false;
        }
      }
      if (running) log(`watch: stopped completion observation for session ${sessionId} after 10 minutes (matched prompt: ${matchedPrompt})`);
    } catch (err) {
      error(`watch: session completion observation failed for ${sessionId}: ${(err as Error).message}`);
    } finally {
      monitoredSessions.delete(monitorKey);
    }
  };

  /**
   * 可靠投递的失败回收（§5/§7.3）：显式状态写回 pending + 指数退避 + 失败计数，
   * 达到上限后不再自动重试（长退避 + failed 活动，需人工重新唤醒）。
   */
  const failDelivery = async (item: WakeItem, claimToken: string, dispatchId: string, reason: string): Promise<void> => {
    const meta = store.queueMeta(item.commentId);
    const attempts = (meta?.attempts ?? 0) + 1;
    const finalFailure = attempts >= WAKE_MAX_ATTEMPTS;
    const base = options.backoffBaseMs ?? 30_000;
    const cap = options.backoffMaxMs ?? 10 * 60_000;
    const backoff = Math.min(base * 2 ** (attempts - 1), cap);
    // 终态失败（达上限）：同语句写 terminal_at（人工门禁，无自动重投）。
    const notBefore = new Date(Date.now() + (finalFailure ? 24 * 60 * 60_000 : backoff)).toISOString();
    const detail = finalFailure
      ? `已重试 ${attempts} 次仍失败，停止自动重试：${reason}`
      : `投递失败（第 ${attempts}/${WAKE_MAX_ATTEMPTS} 次），${Math.round(backoff / 1000)}s 后重试：${reason}`;
    if (!store.requeueWake(item.commentId, claimToken, dispatchId, detail, notBefore, finalFailure)) {
      error(`watch: could not requeue wake for comment ${item.commentId}; a newer attempt owns it`);
      return;
    }
    seen.delete(item.key);
    await reportExecution(item.issueId, finalFailure ? 'failed' : 'retrying', detail);
  };

  /**
   * 未绑定任务 + 内嵌模式无 headless 通道：这不是失败，只把评论还给队列
   * （外部 watch 侧车可接手）。不增加 attempts、不写 failed 活动。
   */
  const parkForExternalSidecar = (item: WakeItem, claimToken: string): void => {
    if (!store.releaseWake(item.commentId, claimToken, 'pending')) {
      error(`watch: could not release wake claim for comment ${item.commentId}; a newer attempt owns it`);
    }
    seen.delete(item.key);
    log('watch: leaving wake pending for the external sidecar');
  };

  /**
   * Claim before deliver, then route. Returns true when the wake was handled
   * (including "another attempt already owns it"); false means the caller may
   * retry on a future event.
   */
  const deliverWake = async (item: WakeItem): Promise<boolean> => {
    const issue = store.getIssue(item.issueId);
    if (!issue) {
      error(`watch: cannot load task ${item.issueId} (not found); wake skipped`);
      return false;
    }
    const prompt = buildWakePrompt(item.issueId, item.issueTitle, item.instruction);
    // Routing URLs are deployment configuration now: no per-project channel is
    // persisted, so only the explicit opencode base and --tui-url fallback apply.
    const projectChannel: string | null = null;
    const tuiUrl = channelFor(projectChannel, config.tuiBase);
    const execParts = config.execParts;

    // An unbound task needs a TUI or headless channel. The embedded engine has
    // neither, so it must skip BEFORE claiming: claim+revert cycles would starve
    // a coexisting external sidecar (which also sees 'no longer pending') and
    // leave the wake pending forever. Skipping keeps it claimable by the sidecar.
    if (!issue.sessionId && !tuiUrl && (!execParts || execParts.length === 0)) {
      if (!parked.has(item.key)) {
        parked.add(item.key);
        log(`watch: task ${item.issueId} has no bound session and no unbound channel; leaving wake pending for the external sidecar`);
      }
      return false;
    }

    // CAS claim AFTER routing is known: the comment is already 'processing'
    // before any HTTP side effect, so a crash cannot leave two attempts
    // believing they own it.
    const claim = store.claimWake(item.commentId, 'watch', runId);
    if (!claim) {
      error(`watch: wake skipped for comment ${item.commentId}; it is no longer pending`);
      return true;
    }
    const { token: claimToken, dispatchId } = claim;
    inFlight.add(item.commentId);

    await reportExecution(item.issueId, 'started', '收到唤醒请求，开始解析任务路由');

    if (issue.sessionId) {
      // Session binding is authoritative. Never inject a bound task into the
      // currently selected TUI session, and never silently spawn a new session.
      const sessionCandidates = sessionBaseCandidates(config.opencodeBase, projectChannel, tuiUrl);
      const sessionBase = await firstHealthySessionBase(sessionCandidates);
      // decideWake owns the routing decision (bound + reachable server →
      // prompt). A bound task that fails it must refuse: falling through to
      // TUI/headless would inject into the WRONG session.
      if (decideWake(issue.sessionId, sessionBase) !== 'prompt') {
        const reason = `任务绑定 Session ${issue.sessionId}，但没有可用的 OpenCode 服务；拒绝回退到其他会话`;
        error(`watch: task ${item.issueId} is bound to ${issue.sessionId}, but no healthy OpenCode server is reachable (checked: ${sessionCandidates.join(', ') || 'none'}); refusing to start a new session`);
        await failDelivery(item, claimToken, dispatchId, reason);
        return false;
      }
      const sessionId = issue.sessionId;
      const healthyBase = sessionBase!;
      // 会话保护租约：先于 probe 获取，覆盖 probe→POST→ack 临界区。
      const leaseKey = `${normalizeLeaseBase(healthyBase)}|${sessionId}`;
      let lease = store.wakeLeaseRenew({ leaseKey, holderRun: runId, commentId: item.commentId, dispatchId, nowIso: nowIso(), ttlMs: LEASE_TTL_MS })
        ? store.wakeLeaseGet(leaseKey)
        : store.wakeLeaseAcquire({ leaseKey, sessionId, serverUrl: healthyBase, holderRun: runId, commentId: item.commentId, dispatchId, nowIso: nowIso(), ttlMs: LEASE_TTL_MS });
      if (!lease) {
        seen.delete(item.key);
        await reportExecution(item.issueId, 'queued', '目标会话被其他投递租约占用，本轮延后');
        return true;
      }
      // 执行通道互斥（§5.1）：会话正忙（agent 在跑）时不注入新 prompt——会打断
      // 当前轮次。放回队列 + not_before 退避，等空闲后由轮询重投；探测失败按空闲
      // 处理（fail-open，不能因为探测抖动卡住投递）。
      const st = await sessionState(healthyBase, sessionId, issue.worktreePath);
      if (st !== 'idle') {
        const deferMs = options.busyDeferMs ?? 30_000;
        const maxWaitMs = options.busyMaxWaitMs ?? 2 * 60 * 60 * 1000;
        const meta = store.queueMeta(item.commentId);
        const waitedMs = (meta?.busyAccumMs ?? 0) + (meta?.busySince ? Date.now() - Date.parse(meta.busySince) : 0);
        if (st === 'busy' && waitedMs > maxWaitMs) {
          const reason = `目标会话持续占用超过 ${Math.round(maxWaitMs / 60000)} 分钟，唤醒等待超时`;
          const retryAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
          if (store.deferBusyTimeout(item.commentId, claimToken, dispatchId, reason, retryAt)) {
            store.wakeLeaseReleaseHeld(leaseKey, lease.fence, runId, item.commentId, dispatchId);
            seen.delete(item.key);
            error(`watch: wake #${item.issueId} timed out waiting for a busy session; requeued with 24h backoff`);
            return true;
          }
        }
        const deferUntil = new Date(Date.now() + deferMs).toISOString();
        const deferred = st === 'busy'
          ? store.deferWakeBusy(item.commentId, claimToken, dispatchId, deferUntil)
          : store.deferWakeUnknown(item.commentId, claimToken, dispatchId, deferUntil);
        if (!deferred) {
          error(`watch: session ${sessionId} is ${st} and comment ${item.commentId} is no longer owned by this attempt`);
          return true;
        }
        store.wakeLeaseReleaseHeld(leaseKey, lease.fence, runId, item.commentId, dispatchId);
        seen.delete(item.key);
        log(`watch: session ${sessionId} ${st}; deferred wake #${item.issueId} until ${deferUntil}`);
        const lastReport = busyDeferReportedAt.get(item.key) ?? 0;
        if (Date.now() - lastReport > 10 * 60_000) {
          busyDeferReportedAt.set(item.key, Date.now());
          await reportExecution(item.issueId, 'queued', st === 'busy'
            ? `目标会话执行中，唤醒已排队（每 ${Math.round(deferMs / 1000)}s 重试）`
            : '会话状态未知，暂停投递与 busy 计时（不消耗重试预算）');
        }
        return true;
      }
      // probe=idle：busy episode 结束，清零后进入发送临界区。
      store.resetBusy(item.commentId, claimToken, dispatchId);
      if (!store.wakeLeaseMarkDispatching(leaseKey, lease.fence, dispatchId, nowIso())) {
        // 租约在核验间隙丢失（被接管）→ 本轮放弃，下轮重新获取。
        seen.delete(item.key);
        await reportExecution(item.issueId, 'queued', '发送租约已被接管，本轮延后');
        return true;
      }
      // A task bound to a worktree must not dispatch into a Session rooted at
      // the project's main checkout. Query sessions in the target directory
      // and fail closed when the bound Session cannot be found there.
      if (issue.worktreePath) {
        try {
          const sessionsRes = await request(`${healthyBase}/session?directory=${encodeURIComponent(issue.worktreePath)}`);
          if (!sessionsRes.ok) throw new Error(`OpenCode returned HTTP ${sessionsRes.status}`);
          const sessions = await sessionsRes.json() as { id?: string; directory?: string }[];
          const boundSession = Array.isArray(sessions) ? sessions.find(entry => entry?.id === sessionId) : undefined;
          const normalizePath = (value: string): string => {
            const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
            return deps.platform === 'win32' ? normalized.toLowerCase() : normalized;
          };
          if (!boundSession?.directory || normalizePath(boundSession.directory) !== normalizePath(issue.worktreePath)) {
            const reason = `Session ${sessionId} 不在绑定的 Worktree 目录 ${issue.worktreePath} 中；请在任务详情中创建工作树 Session 后重试`;
            error(`watch: refusing to dispatch task ${item.issueId}; session directory does not match worktree path`);
            await failDelivery(item, claimToken, dispatchId, reason);
            return false;
          }
        } catch (err) {
          const reason = `无法验证 Session ${sessionId} 与 Worktree 目录的对应关系：${(err as Error).message}`;
          error(`watch: ${reason}`);
          await failDelivery(item, claimToken, dispatchId, reason);
          return false;
        }
      }
      try {
        const correlationMarker = makeWakeCorrelationMarker(item.commentId, dispatchId);
        const correlatedPrompt = `${prompt}\n\n[Taskboard correlation marker: ${correlationMarker}. Treat this as metadata; do not repeat it in your answer.]`;
        const res = await request(`${healthyBase}/session/${encodeURIComponent(sessionId)}/prompt_async`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            parts: [{ type: 'text', text: correlatedPrompt }],
            ...(modelRef ? { model: modelRef } : {}),
          }),
        });
        if (res.ok) {
          store.wakeLeaseMarkSent(leaseKey, lease.fence, dispatchId, nowIso(), LEASE_VERIFY_TTL_MS);
          log(`watch: queued prompt in bound session ${sessionId}`);
          await reportExecution(item.issueId, 'queued', `提示词已提交到绑定的 OpenCode Session ${sessionId}；该状态表示已排队，不代表 Agent 已完成`);
          void monitorOpenCodeSession(item.issueId, sessionId, healthyBase, correlationMarker);
          return true;
        }
        if (res.status < 500) {
          const reason = `绑定 Session ${sessionId} 拒绝了提示词请求（HTTP ${res.status}，无副作用）；没有创建备用会话`;
          error(`watch: bound session ${sessionId} rejected prompt (HTTP ${res.status}); no fallback session will be created`);
          store.wakeLeaseConclude(leaseKey, lease.fence, dispatchId, nowIso());
          await failDelivery(item, claimToken, dispatchId, reason);
          return false;
        }
        store.wakeLeaseMarkSent(leaseKey, lease.fence, dispatchId, nowIso(), LEASE_VERIFY_TTL_MS);
        await reportExecution(item.issueId, 'queued', `提示词提交返回 HTTP ${res.status}（结果未知），按可能已投递进入核验`);
        void monitorOpenCodeSession(item.issueId, sessionId, healthyBase, correlationMarker);
        return true;
      } catch (err) {
        store.wakeLeaseMarkSent(leaseKey, lease.fence, dispatchId, nowIso(), LEASE_VERIFY_TTL_MS);
        error(`watch: bound session ${sessionId} failed (${(err as Error).message}); 结果未知，按可能已投递进入核验`);
        await reportExecution(item.issueId, 'queued', '提示词提交结果未知（网络异常），按可能已投递进入核验');
        return true;
      }
    }

    // A task with a worktree must never fall through to a TUI or headless
    // command whose cwd is not guaranteed to be that worktree.
    if (issue.worktreePath) {
      const reason = `任务已绑定 Worktree ${issue.worktreePath}，但没有绑定 OpenCode Session；为避免在错误目录执行，请先创建工作树 Session`;
      error(`watch: refusing to dispatch task ${item.issueId} without a Session bound to its worktree`);
      await failDelivery(item, claimToken, dispatchId, reason);
      return false;
    }

    // Only tasks without a worktree binding may use the TUI input box (which
    // belongs to the currently selected TUI session) or headless spawn fallback.
    if (tuiUrl) {
      try {
        const res = await request(`${tuiUrl}/tui/append-prompt`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: prompt }),
        });
        if (res.ok) {
          log(`watch: appended wake to TUI (${tuiUrl}) — 等待人工回车提交`);
          await reportExecution(item.issueId, 'queued', `唤醒内容已写入 TUI 输入框 ${tuiUrl}，等待人工提交`);
          return true;
        }
        error(`watch: TUI append failed (HTTP ${res.status}) — 尝试 headless`);
      } catch (err) {
        error(`watch: TUI append failed (${(err as Error).message}) — 尝试 headless`);
      }
    }

    // Headless is reserved for tasks without a session binding. Reaching this
    // with no execParts means only a TUI channel existed and it failed; fail
    // closed and leave the comment pending for a human / the external sidecar.
    if (!execParts || execParts.length === 0) {
      parkForExternalSidecar(item, claimToken);
      return false;
    }

    const attempts = [0, 10_000, 25_000];
    for (let i = 0; i < attempts.length; i++) {
      if (attempts[i]! > 0) await sleep(attempts[i]!);
      if (!running) {
        await failDelivery(item, claimToken, dispatchId, '引擎停止，headless 执行中止');
        return false;
      }
      const outcome = await new Promise<'ok' | 'failed' | 'missing'>(resolve => {
        const child = deps.spawn(execParts[0]!, [...execParts.slice(1), ...modelArgs, prompt], { stdio: 'inherit' });
        child.on('exit', code => resolve(code === 0 ? 'ok' : 'failed'));
        child.on('error', () => resolve('missing'));
      });
      if (outcome === 'ok') {
        if (!store.releaseWake(item.commentId, claimToken, 'processed')) {
          error(`watch: headless run succeeded but comment ${item.commentId} is no longer owned by this attempt`);
        }
        await reportExecution(item.issueId, 'succeeded', `Headless Agent 执行成功（第 ${i + 1} 次尝试）`);
        return true;
      }
      if (outcome === 'missing') {
        error(`watch: exec ${execParts[0]} not found in PATH`);
        await reportExecution(item.issueId, 'failed', `找不到执行命令 ${execParts[0]}，请检查 PATH 配置`);
        await failDelivery(item, claimToken, dispatchId, `找不到执行命令 ${execParts[0]}`);
        return false;
      }
      error(`watch: headless run failed (attempt ${i + 1}/${attempts.length})`);
      if (i + 1 < attempts.length) {
        await reportExecution(item.issueId, 'retrying',
          `Headless Agent 第 ${i + 1}/${attempts.length} 次尝试失败，将按重试间隔再次执行`);
      }
    }
    error('watch: headless run failed after all retries — 结果不可用，请检查 exec 命令与目标 agent CLI 状态');
    await reportExecution(item.issueId, 'failed', 'Headless Agent 所有重试均失败，请检查命令、环境变量和 Agent CLI 日志');
    await failDelivery(item, claimToken, dispatchId, 'Headless Agent 所有重试均失败');
    return false;
  };

  const enqueue = (item: WakeItem): void => {
    queue = queue.then(async () => {
      if (!running) {
        seen.delete(item.key);
        return;
      }
      const delivered = await deliverWake(item);
      inFlight.delete(item.commentId);
      if (!delivered) seen.delete(item.key);
    }).catch(err => {
      inFlight.delete(item.commentId);
      seen.delete(item.key);
      if (item.source === 'backfill') error(`watch: 补拉唤醒失败: ${(err as Error).message}`);
      else error(`watch: wake failed: ${(err as Error).message}`);
    });
  };

  /**
   * Probe `${opencodeBase}/global/health` and log only on transitions. Cheap
   * enough for the poll interval (one 2s-bounded request), and it makes a dead
   * channel visible within one poll instead of a silent pending backlog.
   */
  const probeChannelHealth = async (): Promise<void> => {
    const base = config.opencodeBase?.trim();
    if (!base || !running || probeInFlight) return;
    probeInFlight = true;
    try {
      const response = await request(`${base}/global/health`, { headers: { accept: 'application/json' } }, 2_000);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (channelDown) {
        log('watch: RECOVERED opencode reachable again');
        channelDown = false;
      }
    } catch (err) {
      if (!channelDown) {
        error(`watch: WARN opencode unreachable (${(err as Error).message}) — wakes stay pending until it recovers`);
        channelDown = true;
      }
    } finally {
      probeInFlight = false;
    }
  };

  /**
   * Pending sweep: one direct query over pending comments replaces the old
   * project→issue→detail N+1 backfill. The pending set is tiny; filtering by
   * prefix/author/project happens in JS against the same predicates the event
   * path uses. It runs once on start() and, when options.pollMs is set, on a
   * periodic timer; both feed the same serialized queue.
   */
  const sweep = (): void => {
    if (!running) return;
    let found = 0;
    try {
      for (const comment of store.listQueueBatch(new Date().toISOString())) {
        if (!isWakeComment(comment.body, config.prefix)) continue;
        if (isIgnoredAuthor(comment.author, config.ignoreAuthors)) continue;
        if (!wantsProject(config.projectFilter, comment.projectId)) continue;
        const key = wakeKey(comment.issueId, comment.id);
        if (seen.has(key)) continue;
        seen.add(key);
        found++;
        const instruction = comment.body.trimStart().slice(config.prefix.length).trim();
        log(`watch: 补拉唤醒 #${comment.issueId}: ${instruction}`);
        enqueue({
          issueId: comment.issueId,
          commentId: comment.id,
          issueTitle: comment.issueTitle,
          instruction,
          author: comment.author,
          key,
          source: 'backfill',
        });
      }
    } catch (err) {
      error(`watch: 补拉失败: ${(err as Error).message}`);
    }
    if (found) log(`watch: 补拉完成 — ${found} 条漏网唤醒入队`);
  };

  const onEvent = (event: StoreEvent): void => {
    // The EventBus already swallows listener throws; logging here keeps a
    // broken event path observable instead of silently dropping a wake.
    try {
      if (!shouldWake({ type: event.type, payload: event.payload }, config.prefix)) return;
      const payload = event.payload;
      const author = typeof payload.author === 'string' ? payload.author : undefined;
      if (isIgnoredAuthor(author, config.ignoreAuthors)) return;
      const issueId = String(payload.issueId ?? '');
      if (!issueId) return;
      const projectId = store.getIssue(issueId)?.projectId ?? null;
      if (!wantsProject(config.projectFilter, projectId)) return;
      const commentId = String(payload.id ?? '');
      if (!commentId) return;
      const key = wakeKey(issueId, commentId);
      if (seen.has(key)) {
        // Explicit re-wake: a pending status patch (重新唤醒 button / comment
        // edit save) must re-deliver even though the sweep already enqueued
        // this comment. Duplicate comment.created events still return early.
        if (event.type !== 'comment.updated') return;
        seen.delete(key);
      }
      seen.add(key);
      const issueTitle = String(payload.issueTitle ?? '');
      // The event payload truncates body to 200 chars (store.addComment) —
      // read the full comment from the Store so long instructions survive.
      const meta = store.queueMeta(commentId);
      if (meta?.terminalAt) return;
      const fullBody = store.getComment(commentId)?.body ?? String(payload.body ?? '');
      const instruction = fullBody.trimStart().slice(config.prefix.length).trim();
      const by = author ? ` (${author})` : '';
      log(`watch: wake${by}: ${instruction}`);
      enqueue({ issueId, commentId, issueTitle, instruction, author, key, source: 'event' });
    } catch (err) {
      error(`watch: event handling failed: ${(err as Error).message}`);
    }
  };

  const start = async (): Promise<void> => {
    if (running) return;
    if (options.lockKey) {
      const lockPath = path.join(deps.homedir(), '.taskboard', options.lockKey);
      const lock = acquireWatchLock(lockPath);
      if (!lock.ok) {
        log(`watch: 另一实例运行中 (pid ${lock.holder}) — 同通道重复实例退出，避免双注入`);
        return;
      }
      releaseLock = lock.release;
      process.on('exit', releaseLock);
    }
    lifecycle = new AbortController();
    running = true;
    store.registerWakeEngine(runId, options.kind ?? 'sidecar', '', process.pid, nowIso(), nowIso(), '');
    void sweepOrphans();
    unsubscribe = store.subscribe(onEvent);
    sweep();
    if (options.pollMs !== undefined && options.pollMs > 0) {
      // Every tick: health transition check, then drain pending wakes.
      pollTimer = setInterval(() => {
        void probeChannelHealth();
        void sweepStaleProcessing();
        sweep();
      }, options.pollMs);
    }
    heartbeatTimer = setInterval(() => { store.heartbeatWakeEngine(runId, nowIso()); }, options.heartbeatMs ?? 30_000);
    heartbeatTimer.unref?.();
    orphanTimer = setInterval(() => { void sweepOrphans(); }, 5 * 60_000);
    orphanTimer.unref?.();
    void sweepOrphans();
  };

  const stop = async (): Promise<void> => {
    running = false;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (orphanTimer) { clearInterval(orphanTimer); orphanTimer = null; }
    lifecycle.abort();
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    if (releaseLock) {
      process.removeListener('exit', releaseLock);
      releaseLock();
      releaseLock = null;
    }
    await queue.catch(() => undefined);
    monitoredSessions.clear();
    parked.clear();
  };

  return {
    start,
    stop,
    isRunning: () => running,
  };
}
