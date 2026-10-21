// v0.4: 看板反向驱动 — 评论唤醒 agent 侧车。常驻订阅 SSE，发现 @agent 开头
// 的评论即按绑定路由唤醒 agent：已绑定 sessionId → OpenCode v1
// /session/:id/prompt_async（复用原会话并自动执行）；只有未绑定任务才走
// --tui-url 当前 TUI 输入框（人工回车提交）→ headless spawn（全新会话兜底）。
// 绑定会话投递失败时不降级到其他会话，评论保持 pending 供重试。串行执行唤醒
//（排队，不并发轰炸）；流断开 2s 后重连。
// 单实例 flock 锁（.data/watch.lock，进程死残锁自动回收）；断线重连补拉
// 上次断开窗口内漏掉的 @agent 评论（missedWakeComments + 已处理键去重）。
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// Type-only import: a value import here would close a runtime cycle with
// registry.js (registry imports this file for the command table) and crash
// with a TDZ error when a test/entry imports watch.js first.
import type { Command } from './registry.js';
// Domain-layer predicate shared with the Store (which re-opens settled tasks on
// the same rule). Imported from the '/types' subpath so watch never pulls the
// sqlite-backed Store into its process.
import { isWakeComment } from '@taskboard/core/types';



/** Try the explicit endpoint first, then project/TUI routes, deduplicating equivalent URLs. */
export function sessionBaseCandidates(
  opencodeBase: string | undefined,
  projectChannel: string | null | undefined,
  tuiUrl: string | undefined,
): string[] {
  const normalize = (value: string): string => value.trim().replace(/\/+$/, '');
  return [...new Set(
    [opencodeBase, projectChannel ?? undefined, tuiUrl]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map(normalize),
  )];
}

async function firstHealthySessionBase(candidates: readonly string[]): Promise<string | undefined> {
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i]!;
    try {
      // OpenCode's health endpoint is cheap. Probe before sending a prompt so a stale
      // --opencode URL cannot pin the queue against a half-dead TCP listener.
      const response = await fetchWithTimeout(`${candidate}/global/health`, { headers: { accept: 'application/json' } }, 2_000);
      await response.arrayBuffer();
      if (!response.ok) {
        console.error(`watch: OpenCode health check failed (${candidate}, HTTP ${response.status})`);
        continue;
      }
      if (i > 0) {
        console.error(`watch: preferred OpenCode endpoint is unavailable; using reachable fallback ${candidate}`);
      }
      return candidate;
    } catch (err) {
      console.error(`watch: OpenCode health check failed (${candidate}: ${(err as Error).message})`);
    }
  }
  return undefined;
}

export interface SseEvent { name: string; data: string }

export interface OpenCodeMessageLike {
  info?: { id?: string; parentID?: string; role?: string; sessionID?: string; time?: { created?: number; completed?: number }; error?: unknown; finish?: unknown };
  parts?: Array<{ type?: string; text?: string }>;
}

/**
 * Find the Assistant response that follows the exact Taskboard-injected user
 * message. OpenCode's history may contain unrelated work in the same Session;
 * never correlate by Session idle/busy alone.
 */
export function findCorrelatedAssistant(
  input: unknown,
  marker: string,
): { matchedPrompt: boolean; assistant?: OpenCodeMessageLike } {
  if (!Array.isArray(input)) return { matchedPrompt: false };
  const messages = (input as OpenCodeMessageLike[]).map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const at = a.message.info?.time?.created;
      const bt = b.message.info?.time?.created;
      return typeof at === 'number' && typeof bt === 'number' ? at - bt || a.index - b.index : a.index - b.index;
    })
    .map(item => item.message);
  const promptIndex = messages.findIndex(message =>
    message.info?.role === 'user'
    && (message.parts ?? []).some(part => part.type === 'text' && typeof part.text === 'string' && part.text.includes(marker))
  );
  if (promptIndex < 0) return { matchedPrompt: false };
  const promptMessage = messages[promptIndex];
  if (!promptMessage) return { matchedPrompt: false };
  const promptId = promptMessage.info?.id;
  // Prefer OpenCode's explicit parent relationship. This remains correct even
  // when several prompts are queued before the first Assistant response arrives.
  const linkedAssistant = promptId
    ? messages.find(message => message.info?.role === 'assistant' && message.info?.parentID === promptId)
    : undefined;
  if (linkedAssistant) return { matchedPrompt: true, assistant: linkedAssistant };

  // Compatibility fallback for API payloads without parentID: a later user
  // message starts another request, so never cross that boundary.
  const nextUserOffset = messages.slice(promptIndex + 1).findIndex(message => message.info?.role === 'user');
  const endIndex = nextUserOffset < 0 ? messages.length : promptIndex + 1 + nextUserOffset;
  const assistants = messages.slice(promptIndex + 1, endIndex).filter(message => message.info?.role === 'assistant');
  const assistant = assistants.at(-1);
  return assistant ? { matchedPrompt: true, assistant } : { matchedPrompt: true };
}

/**
 * Bound outbound HTTP waits so one stalled OpenCode/API request cannot hold the
 * serialized wake queue forever. The timeout aborts the client request; for
 * prompt_async, delivery can be ambiguous if the server accepted it just before
 * the response stalled, so callers must not assume timeout means not delivered.
 */
export const WATCH_REQUEST_TIMEOUT_MS = 30_000;

export function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = WATCH_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const upstreamSignal = init.signal;
  const abortFromUpstream = (): void => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) abortFromUpstream();
  else upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
    upstreamSignal?.removeEventListener('abort', abortFromUpstream);
  });
}

/** Incremental SSE parser: feed decoded chunks, get complete events. */
export function makeSseParser(onEvent: (name: string, data: string) => void): { push: (chunk: string) => void } {
  let buf = '';
  return {
    push(chunk: string): void {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let name = 'message';
        const dataLines: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) name = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        if (dataLines.length) onEvent(name, dataLines.join('\n'));
      }
    }
  };
}

interface WakePayload { type?: unknown; payload?: { body?: unknown; status?: unknown } }

/**
 * Only fresh pending comments starting with the prefix wake the agent, on
 * either comment.created (new comment) or comment.updated (saved edit re-queues
 * an edited pending comment).
 */
export function shouldWake(evt: WakePayload, prefix: string): boolean {
  if (evt.type !== 'comment.created' && evt.type !== 'comment.updated') return false;
  const { status, body } = evt.payload ?? {};
  if (status !== undefined && status !== 'pending') return false;
  return typeof body === 'string' && isWakeComment(body, prefix);
}

/**
 * 未绑定任务的 TUI 通道决议：项目绑定的 wake_channel 优先，其次 watch 的
 * --tui-url 兜底；绑定了 sessionId 的任务不使用该通道，而走原会话 API。
 */
export function channelFor(projectChannel: string | null, fallback: string | undefined): string | undefined {
  const normalize = (value: string): string => value.trim().replace(/\/+$/, '');
  const bound = projectChannel && projectChannel.trim() !== '' ? normalize(projectChannel) : undefined;
  return bound ?? (fallback ? normalize(fallback) : undefined);
}

/**
 * 项目路由：可选的作用域过滤（--project）。项目未解析出（null）不唤醒——
 * 宁可漏也不能误投到别的项目管道。projectId 由调用方按需解析后传入。
 */
export function wantsProject(filter: string | undefined, projectId: string | null): boolean {
  return !filter || projectId === filter;
}

/**
 * Self-wake guard: an agent that writes an `@agent`-prefixed comment must not
 * re-wake itself in a loop. Actor names are compared case-insensitively; the
 * sidecar's own actor is always implicit, extra names come from
 * `--ignore-author a,b`.
 */
export function isIgnoredAuthor(author: string | undefined, ignore: ReadonlySet<string>): boolean {
  return typeof author === 'string' && ignore.has(author.trim().toLowerCase());
}

export function buildWakePrompt(issueId: string, issueTitle: string, instruction: string): string {
  return `#${issueId} ${issueTitle}\n`
    + '[看板唤醒] 主进程忙时先收尾手头任务，再处理本条；勿中断进行中的工作。\n'
    + '收尾：处理完把本次唤醒评论置为 processed（MCP update_comment status=processed），否则面板会一直显示「唤醒中」。\n'
    + `指令：${instruction}`;
}

/**
 * SSE 实时流与断线补拉共用同一键防重复注入。
 *
 * Keyed by comment id, not body: two different wake comments can carry the
 * exact same instruction text, and keying on the body silently swallowed the
 * second one (it looked "already processed").
 */
export function wakeKey(issueId: string, commentId: string): string {
  return `${issueId}:${commentId}`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * O_EXCL 锁文件互斥：客户端没有现成 flock，等价做法是独占创建 .data/watch.lock
 * 并写入 PID。持锁进程死亡残锁由下一次启动检测 stale PID 自动回收。
 */
export function acquireWatchLock(lockPath: string): { ok: true; release: () => void } | { ok: false; holder: number } {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const claim = (): { ok: true; release: () => void } => {
    const fd = openSync(lockPath, 'wx');
    try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
    return { ok: true, release: () => { try { unlinkSync(lockPath); } catch { /* 已被回收 */ } } };
  };
  try {
    return claim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const raw = readFileSync(lockPath, 'utf8').trim();
    const pid = Number(raw);
    if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) return { ok: false, holder: pid };
    unlinkSync(lockPath);
    return claim();
  }
}

interface CommentLike { id: string; body: string; status?: string; createdAt: string; author?: string }
export interface IssueDetailLike { id: string; title: string; comments: CommentLike[] }

/**
 * 断线补拉筛选：窗口内以 prefix 开头的评论且未在 processed 集合出现过的才补唤醒。
 * 纯函数导出供测试。
 */
export function missedWakes(
  issues: ReadonlyArray<IssueDetailLike>,
  sinceMs: number,
  prefix: string,
  seen: ReadonlySet<string>,
  ignore: ReadonlySet<string> = new Set(),
): Array<{ issueId: string; commentId: string; issueTitle: string; instruction: string; key: string }> {
  const out: { issueId: string; commentId: string; issueTitle: string; instruction: string; key: string }[] = [];
  for (const it of issues) {
    for (const c of it.comments) {
      if (Date.parse(c.createdAt) <= sinceMs) continue;
      if (c.status !== undefined && c.status !== 'pending') continue;
      if (isIgnoredAuthor(c.author, ignore)) continue;
      if (!isWakeComment(c.body, prefix)) continue;
      const key = wakeKey(it.id, c.id);
      if (seen.has(key)) continue;
      out.push({ issueId: it.id, commentId: c.id, issueTitle: it.title, instruction: c.body.trimStart().slice(prefix.length).trim(), key });
    }
  }
  return out;
}

/**
 * A task bound to an opencode session (and a reachable opencode server)
 * wakes via session prompt injection — same conversation, TUI-visible.
 * Everything else falls back to the headless spawn.
 */
export function decideWake(sessionId: string | null | undefined, opencodeBase: string | undefined | null): 'prompt' | 'spawn' {
  return Boolean(sessionId) && Boolean(opencodeBase) ? 'prompt' : 'spawn';
}

export const watchCommand: Command = {
  summary: 'Wake an agent when a comment starts with @agent',
  usage:               'watch [--on PREFIX] [--tui-url URL] [--opencode URL] [--exec CMD] [--model M] [--project ID] [--ignore-author A,B]',
  bare: true,
  async run(ctx) {
    const { base, token, flags } = ctx;
    const prefix = String(flags.on ?? '@agent');
    const execParts = String(flags.exec ?? 'opencode run').split(' ').filter(s => s.length > 0);
    // 显式模型：headless run 的内置默认模型可能已从上游目录移除（实测
    // minimax-m2.5-free 被移除导致 ProviderModelNotFoundError），钉死可靠 id。
    const model = String(flags.model ?? process.env.OPENCODE_MODEL ?? '');
    const modelArgs = model ? ['-m', model] : [];
    // v1 prompt_async 也接受显式 model 覆盖。已绑定的会话会一直沿用创建时的模型，
    // 而那个模型可能额度耗尽或已下线（实测 zai-coding-plan 周额度用尽直接失败）。
    // 只有 `provider/model` 形式的 id 才能拆成 v1 的 {providerID, modelID}。
    const [modelProvider, ...modelRest] = model.split('/');
    const modelRef = modelRest.length > 0
      ? { providerID: modelProvider!, modelID: modelRest.join('/') }
      : undefined;
    // opencode server base — when set, tasks bound to a session wake via
    // prompt injection instead of a headless spawn.
    const opencodeBase = String(flags.opencode ?? process.env.OPENCODE_SERVER_URL ?? process.env.TASKBOARD_OPENCODE_URL ?? '').replace(/\/+$/, '') || undefined;
    // opencode TUI remote-control base — when set, wakes append the prompt
    // into the attached TUI's input box (POST /tui/append-prompt). The human
    // reviews and presses enter: same session, full context, TUI-visible.
    const tuiBase = String(flags['tui-url'] ?? process.env.OPENCODE_TUI_URL ?? '').replace(/\/+$/, '') || undefined;
    const projectFilter = String(flags.project ?? '') || undefined;
    // 自我唤醒防护：agent 自己写 `@agent` 开头的评论不应再把自己叫醒（循环）。
    // 'watch' 是侧车自己的 actor，永远忽略；agent 名由部署方用
    // --ignore-author 显式列出（默认不过滤，避免误伤 agent 间协作）。
    const ignoreAuthors = new Set(
      ['watch', ...String(flags['ignore-author'] ?? '').split(',')]
        .map(s => s.trim().toLowerCase()).filter(s => s.length > 0)
    );
    const channels = [
      opencodeBase ? `bound-session(${opencodeBase})` : null,
      tuiBase ? `tui-for-unbound(${tuiBase})` : null,
      `spawn-unbound(${execParts.join(' ')})`
    ].filter(Boolean).join(' → ');
    console.log(`watch: ${base()}/api/events — wake on "${prefix}…" → ${channels}${projectFilter ? ` [project ${projectFilter}]` : ''} — 项目按其 wake_channel 数据绑定投递${tuiBase ? `（--tui-url ${tuiBase} 兜底未绑定项目）` : ''}`);

    // 单实例互斥（D5）与断线补拉窗口（D2）。锁名按 server 端口 + 作用域归一：
    // 数据驱动路由后 tui 端口是输出而非身份，通道全由数据决定——同一 server
    // 同一项目作用域的第二实例才该被拦。
    const serverPort = new URL(base()).port || '80';
    const lockId = [serverPort, projectFilter ?? 'all'].join('-').replace(/[^A-Za-z0-9.-]/g, '_');
    const lock = acquireWatchLock(path.join(os.homedir(), '.taskboard', `watch-${lockId}.lock`));
    if (!lock.ok) {
      console.log(`watch: 另一实例运行中 (pid ${lock.holder}) — 同通道重复实例退出，避免双注入`);
      return;
    }
    process.on('exit', () => lock.release());
    const processed = new Set<string>();
    // SSE 载荷不带 projectId——按需 GET 详情解析，按 issue 缓存 promise 防并发重复请求。
    const projectCache = new Map<string, Promise<string | null>>();
    // 兼容旧服务端的项目路由字段；新版本不再返回项目级 OpenCode URL。
    const channelCache = new Map<string, Promise<string | null>>();
    const resolveChannel = (projectId: string | null): Promise<string | null> => {
      if (!projectId) return Promise.resolve(null);
      let cached = channelCache.get(projectId);
      if (!cached) {
        const headers: Record<string, string> = token() ? { Authorization: `Bearer ${token()}` } : {};
        cached = fetchWithTimeout(`${base()}/api/projects/${encodeURIComponent(projectId)}`, { headers })
          .then(r => r.ok ? (r.json() as Promise<{ wakeChannel?: string }>).then(d => d.wakeChannel ?? null) : null)
          .catch(() => null);
        channelCache.set(projectId, cached);
      }
      return cached;
    };
    const resolveProject = (issueId: string): Promise<string | null> => {
      let cached = projectCache.get(issueId);
      if (!cached) {
        const headers: Record<string, string> = token() ? { Authorization: `Bearer ${token()}` } : {};
        cached = fetchWithTimeout(`${base()}/api/issues/${encodeURIComponent(issueId)}`, { headers })
          .then(r => r.ok ? (r.json() as Promise<{ projectId?: string }>).then(d => d.projectId ?? null) : null)
          .catch(() => null);
        projectCache.set(issueId, cached);
      }
      return cached;
    };
    let missedSince = Date.now();
    const backfill = async (): Promise<void> => {
      const since = missedSince;
      missedSince = Date.now();
      try {
        const headers: Record<string, string> = token() ? { Authorization: `Bearer ${token()}` } : {};
        const pr = await fetchWithTimeout(`${base()}/api/projects`, { headers });
        if (!pr.ok) return;
        const allProjects = (await pr.json()) as Array<{ id: string; wakeChannel?: string }>;
        const projects = projectFilter ? allProjects.filter(p => p.id === projectFilter) : allProjects;
        let found = 0;
        for (const p of projects) {
          const lr = await fetchWithTimeout(`${base()}/api/projects/${encodeURIComponent(p.id)}/issues?includeDone=1`, { headers });
          if (!lr.ok) continue;
          const issues = (await lr.json()) as Array<{ id: string }>;
          const backfillChannel = ('wakeChannel' in p ? String(p.wakeChannel) : '') || '';
          for (const it of issues) {
            const dr = await fetchWithTimeout(`${base()}/api/issues/${encodeURIComponent(it.id)}`, { headers });
            if (!dr.ok) continue;
            const detail = (await dr.json()) as IssueDetailLike;
            for (const w of missedWakes([detail], since, prefix, processed, ignoreAuthors)) {
              processed.add(w.key);
              found++;
              console.log(`watch: 补拉唤醒 #${w.issueId}: ${w.instruction}`);
              const backfillTui = channelFor(backfillChannel, tuiBase);
              queue = queue.then(async () => {
                const delivered = await executeWake(w.issueId, buildWakePrompt(w.issueId, w.issueTitle, w.instruction), backfillTui, w.commentId, backfillChannel);
                if (!delivered) processed.delete(w.key);
              }).catch(err => { processed.delete(w.key); console.error(`watch: 补拉唤醒失败: ${(err as Error).message}`); });
            }
          }
        }
        if (found) console.log(`watch: 补拉完成 — ${found} 条漏网唤醒入队`);
      } catch (err) {
        console.error(`watch: 补拉失败: ${(err as Error).message}`);
      }
    };

    let queue: Promise<void> = Promise.resolve();
    const markStatus = async (commentId: string, status: string): Promise<void> => {
      if (!commentId) return;
      try {
        await fetchWithTimeout(`${base()}/api/comments/${commentId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', 'x-taskboard-actor': 'watch', ...(token() ? { Authorization: `Bearer ${token()}` } : {}) },
          body: JSON.stringify({ status })
        });
      } catch (err) {
        console.error(`watch: comment status failed (${(err as Error).message})`);
      }
    };

    const reportExecution = async (
      issueId: string,
      outcome: 'started' | 'queued' | 'running' | 'idle' | 'retrying' | 'succeeded' | 'failed',
      detail: string
    ): Promise<void> => {
      try {
        const res = await fetchWithTimeout(`${base()}/api/issues/${encodeURIComponent(issueId)}/agent-events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-taskboard-actor': 'watch', ...(token() ? { Authorization: `Bearer ${token()}` } : {}) },
          body: JSON.stringify({ outcome, detail })
        });
        if (!res.ok) console.error(`watch: execution event report failed (HTTP ${res.status})`);
      } catch (err) {
        console.error(`watch: execution event report failed (${(err as Error).message})`);
      }
    };

    // OpenCode prompt_async acknowledges only queueing. A unique marker lets us
    // find the exact user message in the Session history; success requires a later
    // assistant response AND the Session returning to idle. Idle alone is never success.
    const monitoredSessions = new Set<string>();
    const makeWakeCorrelationMarker = (commentId: string, issuedAt = Date.now()): string =>
      `taskboard-wake:${commentId || 'unknown'}:${issuedAt}`;
    const monitorOpenCodeSession = async (
      issueId: string, sessionId: string, serverUrl: string, marker: string
    ): Promise<void> => {
      const monitorKey = `${sessionId}:${marker}`;
      if (monitoredSessions.has(monitorKey)) return;
      monitoredSessions.add(monitorKey);
      let observedBusy = false;
      let reportedRunning = false;
      let matchedPrompt = false;
      const deadline = Date.now() + 10 * 60_000;
      try {
        while (Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 2_000));
          const [statusResponse, messagesResponse] = await Promise.all([
            fetchWithTimeout(`${serverUrl}/session/status`),
            fetchWithTimeout(`${serverUrl}/session/${encodeURIComponent(sessionId)}/message?limit=50`)
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
            const error = assistant.info?.error;
            if (error) {
              const detail = typeof error === 'string' ? error : JSON.stringify(error);
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
        console.log(`watch: stopped completion observation for session ${sessionId} after 10 minutes (matched prompt: ${matchedPrompt})`);
      } catch (err) {
        console.error(`watch: session completion observation failed for ${sessionId}: ${(err as Error).message}`);
      } finally {
        monitoredSessions.delete(monitorKey);
      }
    };

    const executeWake = async (issueId: string, prompt: string, tuiUrl?: string, commentId = '', projectChannel?: string | null): Promise<boolean> => {
      // Session binding is authoritative. Never inject a bound task into the
      // currently selected TUI session, and never silently spawn a new session.
      let sessionId: string | null = null;
      let taskWorktreePath = '';
      try {
        const res = await fetchWithTimeout(`${base()}/api/issues/${encodeURIComponent(issueId)}`, {
          headers: token() ? { Authorization: `Bearer ${token()}` } : {}
        });
        if (res.ok) {
          const issue = await res.json() as { sessionId?: string | null; title?: string; worktreePath?: string };
          sessionId = issue.sessionId ?? null;
          taskWorktreePath = issue.worktreePath?.trim() ?? '';
        } else {
          console.error(`watch: cannot load task ${issueId} (HTTP ${res.status}); wake skipped`);
          return false;
        }
      } catch (err) {
        console.error(`watch: cannot load task ${issueId} (${(err as Error).message}); wake skipped`);
        return false;
      }

      await reportExecution(issueId, 'started', '收到唤醒请求，开始解析任务路由');
      if (sessionId) {
        // OpenCode URL is deployment/CLI configuration, never a project field.
        // /prompt_async queues execution in the existing Session without waiting.
        const sessionCandidates = sessionBaseCandidates(opencodeBase, projectChannel, tuiUrl);
        const sessionBase = await firstHealthySessionBase(sessionCandidates);
        // decideWake owns the routing decision (bound + reachable server →
        // prompt). A bound task that fails it must refuse: falling through to
        // TUI/headless would inject into the WRONG session.
        if (decideWake(sessionId, sessionBase) !== 'prompt') {
          const reason = `任务绑定 Session ${sessionId}，但没有可用的 OpenCode 服务；拒绝回退到其他会话`;
          console.error(`watch: task ${issueId} is bound to ${sessionId}, but no healthy OpenCode server is reachable (checked: ${sessionCandidates.join(', ') || 'none'}); refusing to start a new session`);
          await reportExecution(issueId, 'failed', reason);
          return false;
        }
        // A task bound to a worktree must not dispatch into a Session rooted at
        // the project's main checkout. Query sessions in the target directory
        // and fail closed when the bound Session cannot be found there.
        if (taskWorktreePath) {
          try {
            const sessionsRes = await fetchWithTimeout(`${sessionBase}/session?directory=${encodeURIComponent(taskWorktreePath)}`);
            if (!sessionsRes.ok) throw new Error(`OpenCode returned HTTP ${sessionsRes.status}`);
            const sessions = await sessionsRes.json() as { id?: string; directory?: string }[];
            const boundSession = Array.isArray(sessions) ? sessions.find(item => item?.id === sessionId) : undefined;
            const normalizePath = (value: string): string => {
              const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
              return /^[a-zA-Z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
            };
            if (!boundSession?.directory || normalizePath(boundSession.directory) !== normalizePath(taskWorktreePath)) {
              const reason = `Session ${sessionId} 不在绑定的 Worktree 目录 ${taskWorktreePath} 中；请在任务详情中创建工作树 Session 后重试`;
              console.error(`watch: refusing to dispatch task ${issueId}; session directory does not match worktree path`);
              await reportExecution(issueId, 'failed', reason);
              return false;
            }
          } catch (err) {
            const reason = `无法验证 Session ${sessionId} 与 Worktree 目录的对应关系：${(err as Error).message}`;
            await reportExecution(issueId, 'failed', reason);
            console.error(`watch: ${reason}`);
            return false;
          }
        }
        try {
          const correlationMarker = makeWakeCorrelationMarker(commentId);
          const correlatedPrompt = `${prompt}\n\n[Taskboard correlation marker: ${correlationMarker}. Treat this as metadata; do not repeat it in your answer.]`;
          const res = await fetchWithTimeout(`${sessionBase}/session/${encodeURIComponent(sessionId)}/prompt_async`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              parts: [{ type: 'text', text: correlatedPrompt }],
              ...(modelRef ? { model: modelRef } : {})
            })
          });
          if (!res.ok) {
            const reason = `绑定 Session ${sessionId} 拒绝了提示词请求（HTTP ${res.status}）；没有创建备用会话`;
            console.error(`watch: bound session ${sessionId} rejected prompt (HTTP ${res.status}); no fallback session will be created`);
            await reportExecution(issueId, 'failed', reason);
            return false;
          }
          console.log(`watch: queued prompt in bound session ${sessionId}`);
          await markStatus(commentId, 'processing');
          await reportExecution(issueId, 'queued', `提示词已提交到绑定的 OpenCode Session ${sessionId}；该状态表示已排队，不代表 Agent 已完成`);
          void monitorOpenCodeSession(issueId, sessionId!, sessionBase!, correlationMarker);
          return true;
        } catch (err) {
          console.error(`watch: bound session ${sessionId} failed (${(err as Error).message}); no fallback session will be created`);
          await reportExecution(issueId, 'failed', `提交到绑定 Session ${sessionId} 失败：${(err as Error).message}`);
          return false;
        }
      }

      // A task with a worktree must never fall through to a TUI or headless
      // command whose cwd is not guaranteed to be that worktree. Require a
      // Session created in the worktree and validated above.
      if (taskWorktreePath) {
        const reason = `任务已绑定 Worktree ${taskWorktreePath}，但没有绑定 OpenCode Session；为避免在错误目录执行，请先创建工作树 Session`;
        await reportExecution(issueId, 'failed', reason);
        console.error(`watch: refusing to dispatch task ${issueId} without a Session bound to its worktree`);
        return false;
      }

      // Only tasks without a worktree binding may use the TUI input box (which belongs to the
      // currently selected TUI session) or headless spawn fallback.
      if (tuiUrl) {
        try {
          const res = await fetchWithTimeout(`${tuiUrl}/tui/append-prompt`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: prompt })
          });
          if (res.ok) {
            console.log(`watch: appended wake to TUI (${tuiUrl}) — 等待人工回车提交`);
            await markStatus(commentId, 'processing');
            await reportExecution(issueId, 'queued', `唤醒内容已写入 TUI 输入框 ${tuiUrl}，等待人工提交`);
            return true;
          }
          console.error(`watch: TUI append failed (HTTP ${res.status}) — 尝试 headless`);
        } catch (err) {
          console.error(`watch: TUI append failed (${(err as Error).message}) — 尝试 headless`);
        }
      }

      // Headless is reserved for tasks without a session binding.
      const attempts = [0, 10_000, 25_000];
      for (let i = 0; i < attempts.length; i++) {
        if (attempts[i]! > 0) await new Promise(r => setTimeout(r, attempts[i]));
        const outcome = await new Promise<'ok' | 'failed' | 'missing'>(resolve => {
          const child = spawn(execParts[0]!, [...execParts.slice(1), ...modelArgs, prompt], { stdio: 'inherit' });
          child.on('exit', code => resolve(code === 0 ? 'ok' : 'failed'));
          child.on('error', () => resolve('missing'));
        });
        if (outcome === 'ok') {
          await markStatus(commentId, 'processed');
          await reportExecution(issueId, 'succeeded', `Headless Agent 执行成功（第 ${i + 1} 次尝试）`);
          return true;
        }
        if (outcome === 'missing') {
          console.error(`watch: exec ${execParts[0]} not found in PATH`);
          await reportExecution(issueId, 'failed', `找不到执行命令 ${execParts[0]}，请检查 PATH 配置`);
          return false;
        }
        console.error(`watch: headless run failed (attempt ${i + 1}/${attempts.length})`);
        if (i + 1 < attempts.length) {
          await reportExecution(issueId, 'retrying',
            `Headless Agent 第 ${i + 1}/${attempts.length} 次尝试失败，将按重试间隔再次执行`);
        }
      }
      console.error('watch: headless run failed after all retries — 结果不可用，请检查 exec 命令与目标 agent CLI 状态');
      await reportExecution(issueId, 'failed', 'Headless Agent 所有重试均失败，请检查命令、环境变量和 Agent CLI 日志');
      return false;
    };

    const connect = (): void => {
      const controller = new AbortController();
      const url = `${base()}/api/events${token() ? `?token=${encodeURIComponent(token())}` : ''}`;
      fetch(url, { signal: controller.signal, headers: { accept: 'text/event-stream' } })
        .then(async res => {
          if (!res.ok || !res.body) {
            console.error(`watch: stream unavailable (HTTP ${res.status})`);
            controller.abort();
            return;
          }
          console.log('watch: connected');
          void backfill();
          const parser = makeSseParser(async (name, data) => {
            if (name !== 'change') return;
            let evt: WakePayload & { payload?: Record<string, unknown> };
            try { evt = JSON.parse(data); } catch { return; }
            // 项目创建/改绑定/删除 → 通道缓存作废，下一条唤醒按最新绑定路由。
            if (typeof evt.type === 'string' && evt.type.startsWith('project.')) { channelCache.clear(); return; }
            if (!shouldWake(evt, prefix)) return;
            const p = evt.payload ?? {};
            if (isIgnoredAuthor(typeof p.author === 'string' ? p.author : undefined, ignoreAuthors)) return;
            const issueId = String(p.issueId ?? '');
            const projectId = await resolveProject(issueId);
            if (projectFilter && !wantsProject(projectFilter, projectId)) return;
            const projectChannel = await resolveChannel(projectId);
            const tuiUrl = channelFor(projectChannel, tuiBase);
            const issueTitle = String(p.issueTitle ?? '');
            const commentId = String(p.id ?? '');
            const stripped = String(p.body ?? '').trimStart().slice(prefix.length).trim();
            const key = wakeKey(issueId, commentId);
            // 补拉路径可能已先行入队同一条评论——两路径对称查重，杜绝双注入。
            if (processed.has(key)) return;
            processed.add(key);
            const by = typeof p.author === 'string' && p.author ? ` (${p.author})` : '';
            console.log(`watch: wake${by}: ${stripped}`);
            queue = queue.then(async () => {
              const delivered = await executeWake(issueId, buildWakePrompt(issueId, issueTitle, stripped), tuiUrl, commentId, projectChannel);
              if (!delivered) processed.delete(key);
            }).catch(err => { processed.delete(key); console.error(`watch: wake failed: ${(err as Error).message}`); });
          });
          const decoder = new TextDecoder();
          for await (const chunk of res.body) parser.push(decoder.decode(chunk, { stream: true }));
          console.log('watch: stream ended');
        })
        .catch(err => {
          if ((err as Error).name !== 'AbortError') console.error(`watch: ${(err as Error).message}`);
        })
        .finally(() => {
          controller.abort();
          missedSince = Date.now();
          setTimeout(connect, 2000);
        });
    };
    connect();
    await new Promise<void>(() => { /* 常驻 */ });
  }
};
