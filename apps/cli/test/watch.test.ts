// watch 侧车的纯函数层：SSE 增量解析 + 唤醒过滤。网络/进程编排不做单测
// （依赖真实流），这两个纯函数承载全部判断逻辑。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeSseParser, shouldWake, decideWake, buildWakePrompt } from '../src/commands/watch.js';

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
      `#abc123 标题\n[看板唤醒] 排队规则：若主进程当前有处理中的任务，先完成并收尾它，再处理本条评论；不要中断进行中的工作。\n指令：做这个`,
    );
  });
});
