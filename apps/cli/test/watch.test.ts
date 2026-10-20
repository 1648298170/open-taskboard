// watch 侧车的纯函数层：SSE 增量解析 + 唤醒过滤。网络/进程编排不做单测
// （依赖真实流），这两个纯函数承载全部判断逻辑。

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeSseParser, findCorrelatedAssistant, shouldWake, decideWake, buildWakePrompt, acquireWatchLock, missedWakes, wakeKey, wantsProject, channelFor,sessionBaseCandidates, isIgnoredAuthor, fetchWithTimeout, WATCH_REQUEST_TIMEOUT_MS, type IssueDetailLike } from '../src/commands/watch.js';


describe('findCorrelatedAssistant（唤醒请求与 OpenCode 消息关联）', () => {
  const marker = 'taskboard-wake:comment-123:123456';

  it('只匹配包含本次唯一标识的用户消息及其后续 Assistant 回复', () => {
    const result = findCorrelatedAssistant([
      { info: { id: 'assistant-old', role: 'assistant', time: { created: 10 } }, parts: [{ type: 'text', text: '之前的工作已完成' }] },
      { info: { id: 'user-current', role: 'user', time: { created: 20 } }, parts: [{ type: 'text', text: `请处理任务 [${marker}]` }] },
      { info: { id: 'assistant-current', role: 'assistant', time: { created: 30 } }, parts: [{ type: 'text', text: '本次任务已处理' }] },
    ], marker);
    assert.equal(result.matchedPrompt, true);
    assert.equal(result.assistant?.info?.id, 'assistant-current');
  });

  it('没有匹配到本次用户消息时，不把其他 Assistant 回复误判为完成', () => {
    const result = findCorrelatedAssistant([
      { info: { id: 'assistant-other', role: 'assistant', time: { created: 30 } }, parts: [{ type: 'text', text: '其他任务的回复' }] },
      { info: { id: 'user-other', role: 'user', time: { created: 20 } }, parts: [{ type: 'text', text: '别的请求' }] },
    ], marker);
    assert.deepEqual(result, { matchedPrompt: false });
  });

  it('识别到本次用户消息但尚无 Assistant 回复时保持 pending', () => {
    const result = findCorrelatedAssistant([
      { info: { id: 'user-current', role: 'user', time: { created: 20 } }, parts: [{ type: 'text', text: marker }] },
    ], marker);
    assert.deepEqual(result, { matchedPrompt: true });
  });

  it('遇到后续新的用户消息时，不把后一个请求的回复归给前一个唤醒', () => {
    const result = findCorrelatedAssistant([
      { info: { id: 'user-current', role: 'user', time: { created: 20 } }, parts: [{ type: 'text', text: marker }] },
      { info: { id: 'user-next', role: 'user', time: { created: 30 } }, parts: [{ type: 'text', text: '另一个请求' }] },
      { info: { id: 'assistant-next', role: 'assistant', time: { created: 40 } }, parts: [{ type: 'text', text: '另一个请求的回复' }] },
    ], marker);
    assert.deepEqual(result, { matchedPrompt: true });
  });

  it('多个用户请求先入队时，优先通过 parentID 找到对应回复', () => {
    const result = findCorrelatedAssistant([
      { info: { id: 'user-current', role: 'user', time: { created: 20 } }, parts: [{ type: 'text', text: marker }] },
      { info: { id: 'user-next', role: 'user', time: { created: 30 } }, parts: [{ type: 'text', text: '另一个请求' }] },
      { info: { id: 'assistant-current', parentID: 'user-current', role: 'assistant', time: { created: 40 } }, parts: [{ type: 'text', text: '本次请求的回复' }] },
      { info: { id: 'assistant-next', parentID: 'user-next', role: 'assistant', time: { created: 50 } }, parts: [{ type: 'text', text: '另一个请求的回复' }] },
    ], marker);
    assert.equal(result.assistant?.info?.id, 'assistant-current');
  });
});

describe('makeSseParser', () => {
  it('reassembles events from split chunks', () => {
    const events: { name: string; data: string }[] = [];
    const parser = makeSseParser((name, data) => events.push({ name, data }));
    parser.push('event: change\ndata: {"a"');
    parser.push(':1}\n\n');
    assert.deepEqual(events, [{ name: 'change', data: '{"a":1}' }]);
  });

  it('ignores comment-only blocks (keepalive pings)', () => {
    const events: { name: string; data: string }[] = [];
    const parser = makeSseParser((name, data) => events.push({ name, data }));
    parser.push(': ping\n\n');
    assert.deepEqual(events, []);
  });

  it('joins multi-line data and defaults the event name', () => {
    const events: { name: string; data: string }[] = [];
    const parser = makeSseParser((name, data) => events.push({ name, data }));
    parser.push('data: l1\ndata: l2\n\n');
    assert.deepEqual(events, [{ name: 'message', data: 'l1\nl2' }]);
  });
});

describe('shouldWake', () => {
  const P = '@agent';
  it('wakes on fresh comments starting with the prefix', () => {
    assert.equal(shouldWake({ type: 'comment.created', payload: { body: '@agent 做下一个任务' } }, P), true);
  });
  it('tolerates leading whitespace, matching the Store re-open rule', () => {
    assert.equal(shouldWake({ type: 'comment.created', payload: { body: '\n  @agent 做下一个任务' } }, P), true);
  });
  it('ignores plain comments, other events, and malformed payloads', () => {
    assert.equal(shouldWake({ type: 'comment.created', payload: { body: '普通评论' } }, P), false);
    assert.equal(shouldWake({ type: 'issue.updated', payload: { body: '@agent' } }, P), false);
    assert.equal(shouldWake({ type: 'comment.created', payload: {} }, P), false);
    assert.equal(shouldWake({ type: 'comment.created' }, P), false);
  });
});

describe('decideWake', () => {
  it('routes to session prompt only with both binding and server', () => {
    assert.equal(decideWake('ses_x', 'http://127.0.0.1:4096'), 'prompt');
    assert.equal(decideWake(null, 'http://127.0.0.1:4096'), 'spawn');
    assert.equal(decideWake('ses_x', undefined), 'spawn');
    assert.equal(decideWake(undefined, undefined), 'spawn');
  });
});

describe('buildWakePrompt', () => {
  it('carries issue ref and instruction', () => {
    assert.equal(
      buildWakePrompt('abc123', '标题', '做这个'),
      `#abc123 标题\n[看板唤醒] 主进程忙时先收尾手头任务，再处理本条；勿中断进行中的工作。\n收尾：处理完把本次唤醒评论置为 processed（MCP update_comment status=processed），否则面板会一直显示「唤醒中」。\n指令：做这个`,
    );
  });
});

describe('acquireWatchLock', () => {
  const dir = path.join(os.tmpdir(), `taskboard-watch-test-${process.pid}`);
  beforeEach(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('claims a free lock and release unlinks it', () => {
    const lockPath = path.join(dir, 'watch.lock');
    const lock = acquireWatchLock(lockPath);
    assert.equal(lock.ok, true, 'lock should be free');
    if (lock.ok) {
      assert.equal(fs.readFileSync(lockPath, 'utf8'), String(process.pid));
      lock.release();
      assert.equal(fs.existsSync(lockPath), false, 'release should unlink');
    }
  });

  it('reports an alive holder and does not steal', () => {
    const lockPath = path.join(dir, 'watch.lock');
    fs.writeFileSync(lockPath, String(process.pid));
    const lock = acquireWatchLock(lockPath);
    assert.equal(lock.ok, false, 'alive pid holds the lock');
    if (!lock.ok) assert.equal(lock.holder, process.pid);
  });

  it('recovers a stale lock from a dead pid', () => {
    const lockPath = path.join(dir, 'watch.lock');
    fs.writeFileSync(lockPath, '999999999');
    const lock = acquireWatchLock(lockPath);
    assert.equal(lock.ok, true, 'dead pid lock should be recycled');
    if (lock.ok) lock.release();
  });

  it('recovers an empty / garbage lock file', () => {
    const lockPath = path.join(dir, 'watch.lock');
    fs.writeFileSync(lockPath, '');
    const lock = acquireWatchLock(lockPath);
    assert.equal(lock.ok, true);
    if (lock.ok) lock.release();
  });
});

describe('missedWakes', () => {
  const comment = (body: string, msAgo: number, id = `c${msAgo}`): { id: string; body: string; createdAt: string } => ({
    id, body, createdAt: new Date(Date.now() - msAgo).toISOString(),
  });

  it('selects only fresh prefix comments not already seen', () => {
    const seen = new Set<string>();
    const issues: IssueDetailLike[] = [{
      id: 'i1', title: 'T', comments: [
        comment('@agent 新来的', 1_000),
        comment('@agent 旧到窗口外', 60_000),
        { id: 'c2', body: '普通评论', createdAt: new Date().toISOString() },
      ],
    }];
    const missed = missedWakes(issues, Date.now() - 30_000, '@agent', seen);
    assert.equal(missed.length, 1);
    assert.equal(missed[0].instruction, '新来的');
    assert.equal(missed[0].issueId, 'i1');
  });

  it('dedupes keys already processed by the live stream', () => {
    const issues: IssueDetailLike[] = [{ id: 'i1', title: 'T', comments: [comment('@agent 一条', 1_000, 'cx')] }];
    const seen = new Set([wakeKey('i1', 'cx')]);
    assert.equal(missedWakes(issues, 0, '@agent', seen).length, 0);
  });

  it('keeps identical bodies apart — the key is the comment id, not the text', () => {
    const issues: IssueDetailLike[] = [{
      id: 'i1', title: 'T', comments: [
        comment('@agent 同一句', 2_000, 'c1'),
        comment('@agent 同一句', 1_000, 'c2'),
      ],
    }];
    const seen = new Set([wakeKey('i1', 'c1')]);
    const missed = missedWakes(issues, 0, '@agent', seen);
    assert.equal(missed.length, 1);
    assert.equal(missed[0].commentId, 'c2');
  });

  it('tolerates leading whitespace when extracting the instruction', () => {
    const issues: IssueDetailLike[] = [{ id: 'i1', title: 'T', comments: [comment('\n  @agent 带前导空白', 1_000, 'cw')] }];
    const missed = missedWakes(issues, 0, '@agent', new Set());
    assert.equal(missed.length, 1);
    assert.equal(missed[0].instruction, '带前导空白');
  });
});

describe('isIgnoredAuthor（自我唤醒防护）', () => {
  it('matches case-insensitively, trims, and tolerates undefined', () => {
    const ignore = new Set(['sisyphus']);
    assert.equal(isIgnoredAuthor('Sisyphus', ignore), true);
    assert.equal(isIgnoredAuthor('  sisyphus ', ignore), true);
    assert.equal(isIgnoredAuthor('web', ignore), false);
    assert.equal(isIgnoredAuthor(undefined, ignore), false);
  });

  it('drops backfill wakes authored by an ignored actor (default keeps them)', () => {
    const issues: IssueDetailLike[] = [{
      id: 'i1', title: 'T', comments: [
        { id: 'c1', body: '@agent 自己写的', createdAt: new Date().toISOString(), author: 'Sisyphus' },
      ],
    }];
    assert.equal(missedWakes(issues, 0, '@agent', new Set(), new Set(['sisyphus'])).length, 0);
    assert.equal(missedWakes(issues, 0, '@agent', new Set()).length, 1);
  });
});

describe('wantsProject（A 方案多实例项目路由）', () => {
  it('未设 filter 时所有项目都归本实例', () => {
    assert.equal(wantsProject(undefined, null), true);
    assert.equal(wantsProject(undefined, 'demo'), true);
  });

  it('设置 filter 时仅命中该项目；解析失败（null）不唤醒', () => {
    assert.equal(wantsProject('demo', 'demo'), true);
    assert.equal(wantsProject('demo', 'roadmap-v0.4'), false);
    assert.equal(wantsProject('demo', null), false);
  });
});

describe('channelFor（数据驱动 wake_channel 路由）', () => {
  it('项目绑定优先于 --tui-url 兜底', () => {
    assert.equal(channelFor('http://127.0.0.1:4097', 'http://127.0.0.1:4096'), 'http://127.0.0.1:4097');
  });

  it('未绑定或空绑定 → 兜底；全无 → undefined（headless）', () => {
    assert.equal(channelFor('', 'http://f:1'), 'http://f:1');
    assert.equal(channelFor(null, 'http://f:1'), 'http://f:1');
    assert.equal(channelFor('', undefined), undefined);
  });
  
  it('normalizes trailing slashes before using the URL as an API base', () => {
    assert.equal(channelFor('http://127.0.0.1:4096/', undefined), 'http://127.0.0.1:4096');
    assert.equal(channelFor('', 'http://127.0.0.1:4096///'), 'http://127.0.0.1:4096');
  });
});


describe('fetchWithTimeout（防止唤醒队列永久阻塞）', () => {
  it('exports a bounded default timeout', () => {
    assert.equal(WATCH_REQUEST_TIMEOUT_MS, 30_000);
  });

  it('aborts a request that never settles', async () => {
    const originalFetch = globalThis.fetch;
    let observedSignal: AbortSignal | undefined;
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    }) as typeof fetch;
    try {
      await assert.rejects(fetchWithTimeout('http://127.0.0.1:4096/session/ses_test/prompt_async', {}, 10));
      assert.equal(observedSignal?.aborted, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('preserves caller-provided abort signals', async () => {
    const originalFetch = globalThis.fetch;
    const upstream = new AbortController();
    let observedSignal: AbortSignal | undefined;
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    }) as typeof fetch;
    try {
      const pending = fetchWithTimeout('http://127.0.0.1:4096/session/ses_test/prompt_async', { signal: upstream.signal }, 1_000);
      upstream.abort();
      await assert.rejects(pending);
      assert.equal(observedSignal?.aborted, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('preserves caller-provided abort signals', async () => {
    const originalFetch = globalThis.fetch;
    const upstream = new AbortController();
    let observedSignal: AbortSignal | undefined;
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    }) as typeof fetch;
    try {
      const pending = fetchWithTimeout('http://127.0.0.1:4096/session/ses_test/prompt_async', { signal: upstream.signal }, 1_000);
      upstream.abort();
      await assert.rejects(pending);
      assert.equal(observedSignal?.aborted, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
describe('sessionBaseCandidates（唤醒服务地址回退）', () => {
  it('保留显式参数优先级，但在其不可用时可探测项目地址作为备用', () => {
    assert.deepEqual(
      sessionBaseCandidates('http://127.0.0.1:4096', ' http://192.168.3.7:4097/ ', 'http://127.0.0.1:47825/'),
      ['http://127.0.0.1:4096', 'http://192.168.3.7:4097', 'http://127.0.0.1:47825'],
    );
  });

  it('去重规范化后的相同地址', () => {
    assert.deepEqual(
      sessionBaseCandidates('http://127.0.0.1:4097/', 'http://127.0.0.1:4097', undefined),
      ['http://127.0.0.1:4097'],
    );
  });
});
