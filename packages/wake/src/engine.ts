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
  'claimWake' | 'releaseWake' | 'getComment' | 'getIssue' | 'listQueueBatch' | 'queueMeta' | 'requeueWake' | 'deferWake' | 'recordExecutionEvent' | 'subscribe'
>;

/** Narrow child-process surface so tests can inject a deterministic spawn. */
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
  // A per-process nonce keeps correlation markers unique across restarts.
  const engineId = deps.randomUUID();

  let running = false;
  let unsubscribe: (() => void) | null = null;
  let releaseLock: (() => void) | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  // Channel-level watchdog state: one WARN while OpenCode is unreachable, one
  // RECOVERED line when it returns. Pending comments are retried by the sweep
  // either way; these lines are the operator's early signal.
  let channelDown = false;
  let probeInFlight = false;
  let queue: Promise<void> = Promise.resolve();
  let lifecycle = new AbortController();
  const seen = new Set<string>();
  const monitoredSessions = new Set<string>();
  // Comments this engine can never deliver (no binding, no unbound channel).
  // They stay pending for an external sidecar; log once instead of every poll.
  const parked = new Set<string>();

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
   * GET /session/status 判断目标会话是否正在执行（busy/running/retry）。
   * 探测失败按「空闲」处理（fail-open）：探测抖动不应无限推迟投递。
   */
  const sessionBusy = async (base: string, sessionId: string, directory: string): Promise<boolean> => {
    try {
      const url = new URL(`${base}/session/status`);
      if (directory) url.searchParams.set('directory', directory);
      const response = await request(url.toString(), { headers: { accept: 'application/json' } }, 3_000);
      if (!response.ok) return false;
      const payload = await response.json() as unknown;
      if (typeof payload !== 'object' || payload === null) return false;
      const raw = (payload as Record<string, unknown>)[sessionId];
      const type = raw && typeof raw === 'object' && typeof (raw as { type?: unknown }).type === 'string'
        ? (raw as { type: string }).type
        : '';
      return type === 'busy' || type === 'running' || type === 'retry';
    } catch {
      return false;
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
  const makeWakeCorrelationMarker = (commentId: string, issuedAt = Date.now()): string =>
    `taskboard-wake:${commentId || 'unknown'}:${issuedAt}:${engineId.slice(0, 8)}`;

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

  const revertClaim = (item: WakeItem, claimToken: string): void => {
    if (!store.releaseWake(item.commentId, claimToken, 'pending')) {
      error(`watch: could not release wake claim for comment ${item.commentId}; a newer attempt owns it`);
    }
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
    const claimToken = store.claimWake(item.commentId, 'watch');
    if (!claimToken) {
      error(`watch: wake skipped for comment ${item.commentId}; it is no longer pending`);
      return true;
    }

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
        await reportExecution(item.issueId, 'failed', reason);
        revertClaim(item, claimToken);
        return false;
      }
      const sessionId = issue.sessionId;
      const healthyBase = sessionBase!;
      // 执行通道互斥（§5.1）：会话正忙（agent 在跑）时不注入新 prompt——会打断
      // 当前轮次。放回队列 + not_before 退避，等空闲后由轮询重投；探测失败按空闲
      // 处理（fail-open，不能因为探测抖动卡住投递）。
      const busy = await sessionBusy(healthyBase, sessionId, issue.worktreePath);
      if (busy) {
        const deferMs = options.busyDeferMs ?? 30_000;
        const deferUntil = new Date(Date.now() + deferMs).toISOString();
        if (!store.deferWake(item.commentId, claimToken, deferUntil)) {
          error(`watch: session ${sessionId} is busy and comment ${item.commentId} is no longer owned by this attempt`);
          return true;
        }
        // 延后不是投递完成：清掉 seen，让轮询在 not_before 到期后重新入队。
        seen.delete(item.key);
        log(`watch: session ${sessionId} busy; deferred wake #${item.issueId} until ${deferUntil}`);
        await reportExecution(item.issueId, 'queued', `目标会话执行中，唤醒已排队（${Math.round(deferMs / 1000)}s 后重试）`);
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
            await reportExecution(item.issueId, 'failed', reason);
            revertClaim(item, claimToken);
            return false;
          }
        } catch (err) {
          const reason = `无法验证 Session ${sessionId} 与 Worktree 目录的对应关系：${(err as Error).message}`;
          await reportExecution(item.issueId, 'failed', reason);
          error(`watch: ${reason}`);
          revertClaim(item, claimToken);
          return false;
        }
      }
      try {
        const correlationMarker = makeWakeCorrelationMarker(item.commentId);
        const correlatedPrompt = `${prompt}\n\n[Taskboard correlation marker: ${correlationMarker}. Treat this as metadata; do not repeat it in your answer.]`;
        const res = await request(`${healthyBase}/session/${encodeURIComponent(sessionId)}/prompt_async`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            parts: [{ type: 'text', text: correlatedPrompt }],
            ...(modelRef ? { model: modelRef } : {}),
          }),
        });
        if (!res.ok) {
          const reason = `绑定 Session ${sessionId} 拒绝了提示词请求（HTTP ${res.status}）；没有创建备用会话`;
          error(`watch: bound session ${sessionId} rejected prompt (HTTP ${res.status}); no fallback session will be created`);
          await reportExecution(item.issueId, 'failed', reason);
          revertClaim(item, claimToken);
          return false;
        }
        // Accepted: the claim stays 'processing' for the agent to finalize.
        log(`watch: queued prompt in bound session ${sessionId}`);
        await reportExecution(item.issueId, 'queued', `提示词已提交到绑定的 OpenCode Session ${sessionId}；该状态表示已排队，不代表 Agent 已完成`);
        void monitorOpenCodeSession(item.issueId, sessionId, healthyBase, correlationMarker);
        return true;
      } catch (err) {
        error(`watch: bound session ${sessionId} failed (${(err as Error).message}); no fallback session will be created`);
        await reportExecution(item.issueId, 'failed', `提交到绑定 Session ${sessionId} 失败：${(err as Error).message}`);
        revertClaim(item, claimToken);
        return false;
      }
    }

    // A task with a worktree must never fall through to a TUI or headless
    // command whose cwd is not guaranteed to be that worktree.
    if (issue.worktreePath) {
      const reason = `任务已绑定 Worktree ${issue.worktreePath}，但没有绑定 OpenCode Session；为避免在错误目录执行，请先创建工作树 Session`;
      await reportExecution(item.issueId, 'failed', reason);
      error(`watch: refusing to dispatch task ${item.issueId} without a Session bound to its worktree`);
      revertClaim(item, claimToken);
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
      const reason = '没有可用的 headless 执行命令；嵌入式唤醒只投递绑定会话，评论保持待处理';
      error(`watch: task ${item.issueId} has no bound session and headless delivery is disabled; reverting wake to pending`);
      await reportExecution(item.issueId, 'failed', reason);
      revertClaim(item, claimToken);
      return false;
    }

    const attempts = [0, 10_000, 25_000];
    for (let i = 0; i < attempts.length; i++) {
      if (attempts[i]! > 0) await sleep(attempts[i]!);
      if (!running) {
        revertClaim(item, claimToken);
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
        revertClaim(item, claimToken);
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
    revertClaim(item, claimToken);
    return false;
  };

  const enqueue = (item: WakeItem): void => {
    queue = queue.then(async () => {
      if (!running) {
        seen.delete(item.key);
        return;
      }
      const delivered = await deliverWake(item);
      if (!delivered) seen.delete(item.key);
    }).catch(err => {
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
    unsubscribe = store.subscribe(onEvent);
    sweep();
    if (options.pollMs !== undefined && options.pollMs > 0) {
      // Every tick: health transition check, then drain pending wakes.
      pollTimer = setInterval(() => {
        void probeChannelHealth();
        sweep();
      }, options.pollMs);
      // unref: the poll must never be the only thing keeping a test or a
      // shutting-down process alive; stop() clears it as well.
      pollTimer.unref?.();
      void probeChannelHealth();
    }
  };

  const stop = async (): Promise<void> => {
    running = false;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
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
