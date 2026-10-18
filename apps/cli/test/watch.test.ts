// watch 侧车的纯函数层：SSE 增量解析 + 唤醒过滤。网络/进程编排不做单测
// （依赖真实流），这两个纯函数承载全部判断逻辑。

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeSseParser, shouldWake, decideWake, buildWakePrompt, acquireWatchLock, missedWakes, wakeKey, wantsProject, channelFor, type IssueDetailLike } from '../src/commands/watch.js';

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
      `#abc123 标题\n[看板唤醒] 主进程忙时先收尾手头任务，再处理本条；勿中断进行中的工作。\n指令：做这个`,
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
    const seen = new Set([wakeKey('i1', '@agent 一条')]);
    assert.equal(missedWakes(issues, 0, '@agent', seen).length, 0);
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
});
