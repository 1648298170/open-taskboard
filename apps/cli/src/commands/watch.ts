// v0.4: 看板反向驱动 — 评论唤醒 agent 侧车。常驻订阅 SSE，发现 @agent 开头
// 的评论即按通道优先级唤醒 agent：TUI 注入（--tui-url，附着的 TUI 输入框
// 出现指令文本，人工回车提交——同会话、全上下文、模型由 TUI 决定）→ 绑定
// 会话 v2 prompt 注入（--opencode，1.19.3 上游只入队不执行，留作升级后通道）
// → headless spawn（--exec/--model，全新会话兜底）。注意：TUI 未附着时
// append-prompt 可能静默成功且不降级——这是有意的：人不在场就不该无人审核地
// 自动跑 agent。串行执行唤醒（排队，不并发轰炸）；流断开 2s 后重连。
import { spawn } from 'node:child_process';
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
  return `#${issueId} ${issueTitle}\n${instruction}`;
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
          const parser = makeSseParser((name, data) => {
            if (name !== 'change') return;
            let evt: WakePayload & { payload?: Record<string, unknown> };
            try { evt = JSON.parse(data); } catch { return; }
            if (!shouldWake(evt, prefix)) return;
            const p = evt.payload ?? {};
            const issueId = String(p.issueId ?? '');
            const issueTitle = String(p.issueTitle ?? '');
            const stripped = String(p.body ?? '').slice(prefix.length).trim();
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
          setTimeout(connect, 2000);
        });
    };
    connect();
    await new Promise<void>(() => { /* 常驻 */ });
  }
};
