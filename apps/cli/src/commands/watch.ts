// v0.4: 看板反向驱动 — 评论唤醒 agent 侧车。常驻订阅 SSE，发现 @agent 开头
// 的评论即按通道优先级唤醒 agent：TUI 注入（--tui-url，附着的 TUI 输入框
// 出现指令文本，人工回车提交——同会话、全上下文、模型由 TUI 决定）→ 绑定
// 会话 v2 prompt 注入（--opencode，1.19.3 上游只入队不执行，留作升级后通道）
// → headless spawn（--exec/--model，全新会话兜底）。注意：TUI 未附着时
// append-prompt 可能静默成功且不降级——这是有意的：人不在场就不该无人审核地
// 自动跑 agent。串行执行唤醒（排队，不并发轰炸）；流断开 2s 后重连。
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

interface WakePayload { type?: unknown; payload?: { body?: unknown } }

/** Only fresh comments starting with the prefix wake the agent. */
export function shouldWake(evt: WakePayload, prefix: string): boolean {
  if (evt.type !== 'comment.created') return false;
  const body = evt.payload?.body;
  return typeof body === 'string' && body.startsWith(prefix);
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

interface CommentLike { id: string; body: string; createdAt: string }
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
): Array<{ issueId: string; issueTitle: string; instruction: string; key: string }> {
  const out: { issueId: string; issueTitle: string; instruction: string; key: string }[] = [];
  for (const it of issues) {
    for (const c of it.comments) {
      if (Date.parse(c.createdAt) <= sinceMs) continue;
      if (!c.body.startsWith(prefix)) continue;
      const key = wakeKey(it.id, c.body);
      if (seen.has(key)) continue;
      out.push({ issueId: it.id, issueTitle: it.title, instruction: c.body.slice(prefix.length).trim(), key });
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
  usage: 'watch [--on PREFIX] [--tui-url URL] [--opencode URL] [--exec CMD] [--model M]',
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
    const channels = [
      tuiBase ? `tui(${tuiBase})` : null,
      opencodeBase ? `session(${opencodeBase})` : null,
      `spawn(${execParts.join(' ')})`
    ].filter(Boolean).join(' → ');
    console.log(`watch: ${base()}/api/events — wake on "${prefix}…" → ${channels}`);

    // 单实例互斥（D5）与断线补拉窗口（D2）。锁按目标 server 的端口归一
    // （~/.taskboard/watch-<port>.lock）而不是 cwd——同机不同目录起第二实例才拦得住。
    const serverPort = new URL(base()).port || '80';
    const lock = acquireWatchLock(path.join(os.homedir(), '.taskboard', `watch-${serverPort}.lock`));
    if (!lock.ok) {
      console.log(`watch: 另一实例运行中 (pid ${lock.holder}) — 本实例退出，避免双注入`);
      return;
    }
    process.on('exit', () => lock.release());
    const processed = new Set<string>();
    let missedSince = Date.now();
    const backfill = async (): Promise<void> => {
      const since = missedSince;
      missedSince = Date.now();
      try {
        const headers: Record<string, string> = token() ? { Authorization: `Bearer ${token()}` } : {};
        const pr = await fetch(`${base()}/api/projects`, { headers });
        if (!pr.ok) return;
        const projects = (await pr.json()) as Array<{ id: string }>;
        let found = 0;
        for (const p of projects) {
          const lr = await fetch(`${base()}/api/projects/${encodeURIComponent(p.id)}/issues?includeDone=1`, { headers });
          if (!lr.ok) continue;
          const issues = (await lr.json()) as Array<{ id: string }>;
          for (const it of issues) {
            const dr = await fetch(`${base()}/api/issues/${encodeURIComponent(it.id)}`, { headers });
            if (!dr.ok) continue;
            const detail = (await dr.json()) as IssueDetailLike;
            for (const w of missedWakes([detail], since, prefix, processed)) {
              processed.add(w.key);
              found++;
              console.log(`watch: 补拉唤醒 #${w.issueId}: ${w.instruction}`);
              queue = queue.then(() => executeWake(w.issueId, buildWakePrompt(w.issueId, w.issueTitle, w.instruction)))
                .catch(err => console.error(`watch: 补拉唤醒失败: ${(err as Error).message}`));
            }
          }
        }
        if (found) console.log(`watch: 补拉完成 — ${found} 条漏网唤醒入队`);
      } catch (err) {
        console.error(`watch: 补拉失败: ${(err as Error).message}`);
      }
    };

    let queue: Promise<void> = Promise.resolve();
    const executeWake = async (issueId: string, prompt: string): Promise<void> => {
      // 通道 1：TUI 注入（附着的 TUI 输入框出现唤醒文本，人工回车提交）。
      // 同会话、全上下文、实时可见，且模型/agent 由 TUI 自身决定。
      if (tuiBase) {
        try {
          const res = await fetch(`${tuiBase}/tui/append-prompt`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: prompt })
          });
          if (res.ok) {
            console.log(`watch: appended wake to TUI (${tuiBase}) — 等待人工回车提交`);
            return;
          }
          console.error(`watch: TUI append failed (HTTP ${res.status}) — 尝试下一通道`);
        } catch (err) {
          console.error(`watch: TUI append failed (${(err as Error).message}) — 尝试下一通道`);
        }
      }
      // 通道 2：绑定会话的 v2 prompt 注入（opencode 1.19.3 只入队不执行
      // LLM turn，留作上游修复后的通道；失败自动降级 spawn）。
      if (opencodeBase) {
        let sessionId: string | null = null;
        try {
          const res = await fetch(`${base()}/api/issues/${encodeURIComponent(issueId)}`, {
            headers: token() ? { Authorization: `Bearer ${token()}` } : {}
          });
          if (res.ok) sessionId = (await res.json() as { sessionId?: string | null }).sessionId ?? null;
        } catch { /* probe failure → spawn fallback */ }

        if (decideWake(sessionId, opencodeBase) === 'prompt') {
          try {
            const res = await fetch(`${opencodeBase}/api/session/${encodeURIComponent(sessionId!)}/prompt`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ prompt: { text: prompt } })
            });
            if (res.ok) {
              console.log(`watch: prompted bound session ${sessionId}`);
              return;
            }
            console.error(`watch: session prompt failed (HTTP ${res.status}) — falling back to headless`);
          } catch (err) {
            console.error(`watch: session prompt failed (${(err as Error).message}) — falling back to headless`);
          }
        } else if (sessionId) {
          console.log(`watch: task bound to ${sessionId} but no --opencode server — headless fallback`);
        }
      }
      // opencode 1.19.3 的 headless run 偶发 "Unexpected server error"
      // （与交互 TUI 并发访问存储相关，间歇性）——重试三次（0/10/25s）。
      // spawn 本身 ENOENT 属永久错误，不重试。
      const attempts = [0, 10_000, 25_000];
      for (let i = 0; i < attempts.length; i++) {
        if (attempts[i]! > 0) await new Promise(r => setTimeout(r, attempts[i]));
        const outcome = await new Promise<'ok' | 'failed' | 'missing'>(resolve => {
          const child = spawn(execParts[0]!, [...execParts.slice(1), ...modelArgs, prompt], { stdio: 'inherit' });
          child.on('exit', code => resolve(code === 0 ? 'ok' : 'failed'));
          child.on('error', () => resolve('missing'));
        });
        if (outcome === 'ok') return;
        if (outcome === 'missing') { console.error(`watch: exec ${execParts[0]} not found in PATH`); return; }
        console.error(`watch: headless run failed (attempt ${i + 1}/${attempts.length})`);
      }
      console.error('watch: headless run failed after all retries — 结果不可用，请检查 opencode 状态');
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
          const parser = makeSseParser((name, data) => {
            if (name !== 'change') return;
            let evt: WakePayload & { payload?: Record<string, unknown> };
            try { evt = JSON.parse(data); } catch { return; }
            if (!shouldWake(evt, prefix)) return;
            const p = evt.payload ?? {};
            const issueId = String(p.issueId ?? '');
            const issueTitle = String(p.issueTitle ?? '');
            const stripped = String(p.body ?? '').slice(prefix.length).trim();
            const key = wakeKey(issueId, String(p.body ?? ''));
            // 补拉路径可能已先行入队同一条评论——两路径对称查重，杜绝双注入。
            if (processed.has(key)) return;
            processed.add(key);
            const by = typeof p.author === 'string' && p.author ? ` (${p.author})` : '';
            console.log(`watch: wake${by}: ${stripped}`);
            queue = queue.then(() => executeWake(issueId, buildWakePrompt(issueId, issueTitle, stripped)))
              .catch(err => console.error(`watch: wake failed: ${(err as Error).message}`));
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
