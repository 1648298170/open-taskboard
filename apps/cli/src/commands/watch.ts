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

export interface SseEvent { name: string; data: string }

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
  return typeof body === 'string' && body.startsWith(prefix);
}

/**
 * 未绑定任务的 TUI 通道决议：项目绑定的 wake_channel 优先，其次 watch 的
 * --tui-url 兜底；绑定了 sessionId 的任务不使用该通道，而走原会话 API。
 */
export function channelFor(projectChannel: string | null, fallback: string | undefined): string | undefined {
  const bound = projectChannel && projectChannel.trim() !== '' ? projectChannel.trim() : undefined;
  return bound ?? fallback;
}

/**
 * 项目路由：可选的作用域过滤（--project）。项目未解析出（null）不唤醒——
 * 宁可漏也不能误投到别的项目管道。projectId 由调用方按需解析后传入。
 */
export function wantsProject(filter: string | undefined, projectId: string | null): boolean {
  return !filter || projectId === filter;
}

export function buildWakePrompt(issueId: string, issueTitle: string, instruction: string): string {
  return `#${issueId} ${issueTitle}\n`
    + '[看板唤醒] 主进程忙时先收尾手头任务，再处理本条；勿中断进行中的工作。\n'
    + `指令：${instruction}`;
}

/** SSE 实时流与断线补拉共用同一键防重复注入。 */
export function wakeKey(issueId: string, body: string): string {
  return `${issueId}:${body}`;
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

interface CommentLike { id: string; body: string; status?: string; createdAt: string }
interface IssueDetailLike { id: string; title: string; comments: CommentLike[] }

/**
 * 断线补拉筛选：窗口内以 prefix 开头的评论且未在 processed 集合出现过的才补唤醒。
 * 纯函数导出供测试。
 */
export function missedWakes(
  issues: ReadonlyArray<IssueDetailLike>,
  sinceMs: number,
  prefix: string,
  seen: ReadonlySet<string>,
): Array<{ issueId: string; commentId: string; issueTitle: string; instruction: string; key: string }> {
  const out: { issueId: string; commentId: string; issueTitle: string; instruction: string; key: string }[] = [];
  for (const it of issues) {
    for (const c of it.comments) {
      if (Date.parse(c.createdAt) <= sinceMs) continue;
      if (c.status !== undefined && c.status !== 'pending') continue;
      if (!c.body.startsWith(prefix)) continue;
      const key = wakeKey(it.id, c.body);
      if (seen.has(key)) continue;
      out.push({ issueId: it.id, commentId: c.id, issueTitle: it.title, instruction: c.body.slice(prefix.length).trim(), key });
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
  usage:               'watch [--on PREFIX] [--tui-url URL] [--opencode URL] [--exec CMD] [--model M] [--project ID]',
  bare: true,
  async run(ctx) {
    const { base, token, flags } = ctx;
    const prefix = String(flags.on ?? '@agent');
    const execParts = String(flags.exec ?? 'opencode run').split(' ').filter(s => s.length > 0);
    // 显式模型：headless run 的内置默认模型可能已从上游目录移除（实测
    // minimax-m2.5-free 被移除导致 ProviderModelNotFoundError），钉死可靠 id。
    const model = String(flags.model ?? process.env.OPENCODE_MODEL ?? '');
    const modelArgs = model ? ['-m', model] : [];
    // opencode server base — when set, tasks bound to a session wake via
    // prompt injection instead of a headless spawn.
    const opencodeBase = String(flags.opencode ?? process.env.OPENCODE_SERVER_URL ?? '').replace(/\/+$/, '') || undefined;
    // opencode TUI remote-control base — when set, wakes append the prompt
    // into the attached TUI's input box (POST /tui/append-prompt). The human
    // reviews and presses enter: same session, full context, TUI-visible.
    const tuiBase = String(flags['tui-url'] ?? process.env.OPENCODE_TUI_URL ?? '').replace(/\/+$/, '') || undefined;
    const projectFilter = String(flags.project ?? '') || undefined;
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
    // 通道缓存：projectId → 项目 wake_channel。project.created/updated 事件即清空，
    // 下一条唤醒重新拉取（改绑定无需重启 watch）。
    const channelCache = new Map<string, Promise<string | null>>();
    const resolveChannel = (projectId: string | null): Promise<string | null> => {
      if (!projectId) return Promise.resolve(null);
      let cached = channelCache.get(projectId);
      if (!cached) {
        const headers: Record<string, string> = token() ? { Authorization: `Bearer ${token()}` } : {};
        cached = fetch(`${base()}/api/projects/${encodeURIComponent(projectId)}`, { headers })
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
        cached = fetch(`${base()}/api/issues/${encodeURIComponent(issueId)}`, { headers })
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
        const pr = await fetch(`${base()}/api/projects`, { headers });
        if (!pr.ok) return;
        const allProjects = (await pr.json()) as Array<{ id: string; wakeChannel?: string }>;
        const projects = projectFilter ? allProjects.filter(p => p.id === projectFilter) : allProjects;
        let found = 0;
        for (const p of projects) {
          const lr = await fetch(`${base()}/api/projects/${encodeURIComponent(p.id)}/issues?includeDone=1`, { headers });
          if (!lr.ok) continue;
          const issues = (await lr.json()) as Array<{ id: string }>;
          const backfillChannel = ('wakeChannel' in p ? String(p.wakeChannel) : '') || '';
          for (const it of issues) {
            const dr = await fetch(`${base()}/api/issues/${encodeURIComponent(it.id)}`, { headers });
            if (!dr.ok) continue;
            const detail = (await dr.json()) as IssueDetailLike;
            for (const w of missedWakes([detail], since, prefix, processed)) {
              processed.add(w.key);
              found++;
              console.log(`watch: 补拉唤醒 #${w.issueId}: ${w.instruction}`);
              const backfillTui = channelFor(backfillChannel, tuiBase);
              queue = queue.then(async () => {
                const delivered = await executeWake(w.issueId, buildWakePrompt(w.issueId, w.issueTitle, w.instruction), backfillTui, w.commentId);
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
        await fetch(`${base()}/api/comments/${commentId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', 'x-taskboard-actor': 'watch', ...(token() ? { Authorization: `Bearer ${token()}` } : {}) },
          body: JSON.stringify({ status })
        });
      } catch (err) {
        console.error(`watch: comment status failed (${(err as Error).message})`);
      }
    };

    const executeWake = async (issueId: string, prompt: string, tuiUrl?: string, commentId = ''): Promise<boolean> => {
      // Session binding is authoritative. Never inject a bound task into the
      // currently selected TUI session, and never silently spawn a new session.
      let sessionId: string | null = null;
      try {
        const res = await fetch(`${base()}/api/issues/${encodeURIComponent(issueId)}`, {
          headers: token() ? { Authorization: `Bearer ${token()}` } : {}
        });
        if (res.ok) {
          const issue = await res.json() as { sessionId?: string | null; title?: string };
          sessionId = issue.sessionId ?? null;
        } else {
          console.error(`watch: cannot load task ${issueId} (HTTP ${res.status}); wake skipped`);
          return false;
        }
      } catch (err) {
        console.error(`watch: cannot load task ${issueId} (${(err as Error).message}); wake skipped`);
        return false;
      }

      if (sessionId) {
        // Project wakeChannel and --opencode normally point at the same server.
        // Prefer the explicit session server, then use the project's configured
        // OpenCode endpoint. /prompt_async is the OpenCode v1 API that queues
        // execution in the EXISTING session and returns without waiting for it.
        const sessionBase = opencodeBase ?? tuiUrl;
        if (!sessionBase) {
          console.error(`watch: task ${issueId} is bound to ${sessionId}, but no OpenCode server URL is configured; refusing to start a new session`);
          return false;
        }
        try {
          const res = await fetch(`${sessionBase}/session/${encodeURIComponent(sessionId)}/prompt_async`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ parts: [{ type: 'text', text: prompt }] })
          });
          if (!res.ok) {
            console.error(`watch: bound session ${sessionId} rejected prompt (HTTP ${res.status}); no fallback session will be created`);
            return false;
          }
          console.log(`watch: queued prompt in bound session ${sessionId}`);
          await markStatus(commentId, 'processing');
          return true;
        } catch (err) {
          console.error(`watch: bound session ${sessionId} failed (${(err as Error).message}); no fallback session will be created`);
          return false;
        }
      }

      // Only unbound tasks may use the TUI input box (which belongs to the
      // currently selected TUI session) or headless spawn fallback.
      if (tuiUrl) {
        try {
          const res = await fetch(`${tuiUrl}/tui/append-prompt`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: prompt })
          });
          if (res.ok) {
            console.log(`watch: appended wake to TUI (${tuiUrl}) — 等待人工回车提交`);
            await markStatus(commentId, 'processing');
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
        if (outcome === 'ok') { await markStatus(commentId, 'processed'); return true; }
        if (outcome === 'missing') {
          console.error(`watch: exec ${execParts[0]} not found in PATH`);
          return false;
        }
        console.error(`watch: headless run failed (attempt ${i + 1}/${attempts.length})`);
      }
      console.error('watch: headless run failed after all retries — 结果不可用，请检查 exec 命令与目标 agent CLI 状态');
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
            const issueId = String(p.issueId ?? '');
            const projectId = await resolveProject(issueId);
            if (projectFilter && !wantsProject(projectFilter, projectId)) return;
            const tuiUrl = channelFor(await resolveChannel(projectId), tuiBase);
            const issueTitle = String(p.issueTitle ?? '');
            const commentId = String(p.id ?? '');
            const stripped = String(p.body ?? '').slice(prefix.length).trim();
            const key = wakeKey(issueId, String(p.body ?? ''));
            // 补拉路径可能已先行入队同一条评论——两路径对称查重，杜绝双注入。
            if (processed.has(key)) return;
            processed.add(key);
            const by = typeof p.author === 'string' && p.author ? ` (${p.author})` : '';
            console.log(`watch: wake${by}: ${stripped}`);
            queue = queue.then(async () => {
              const delivered = await executeWake(issueId, buildWakePrompt(issueId, issueTitle, stripped), tuiUrl, commentId);
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
