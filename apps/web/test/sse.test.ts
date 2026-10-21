// SSE 客户端纯逻辑单测：change 帧解析、事件类型路由、250ms trailing 合并。
// EventSource 用最小 stub 替换全局构造器，不引入 jsdom。
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { connectSSE, parseSseChange } from '../src/api';
import type { SseChangeEvent } from '../src/api';
import { affectsOpenIssue, classifySseEvent, createSseBatcher } from '../src/logic/sse';

type Listener = (event: MessageEvent<string>) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  private readonly listeners = new Map<string, Listener[]>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  close(): void { this.closed = true; }
  emit(type: string, data: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data } as MessageEvent<string>);
    }
  }
}

const originalEventSource = globalThis.EventSource;

function installFakeEventSource(): void {
  FakeEventSource.instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
}

afterEach(() => {
  (globalThis as unknown as { EventSource: unknown }).EventSource = originalEventSource;
});

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

describe('parseSseChange', () => {
  it('extracts type and the issue id carried by issue events (payload.id)', () => {
    const event = parseSseChange('{"type":"issue.updated","payload":{"id":"i1"},"revision":2,"at":""}');
    assert.deepEqual(event, { type: 'issue.updated', issueId: 'i1' });
  });

  it('prefers payload.issueId when a comment event carries both ids', () => {
    const event = parseSseChange('{"type":"comment.created","payload":{"id":"c1","issueId":"i1"},"revision":3,"at":""}');
    assert.deepEqual(event, { type: 'comment.created', issueId: 'i1' });
  });

  it('does not invent an issue id for project or malformed frames', () => {
    assert.deepEqual(parseSseChange('{"type":"project.created","payload":{"id":"p1"}}'), { type: 'project.created', issueId: null });
    assert.deepEqual(parseSseChange('not-json'), { type: '', issueId: null });
    assert.deepEqual(parseSseChange('null'), { type: '', issueId: null });
  });
});

describe('connectSSE', () => {
  it('emits hello plus parsed change events and closes on dispose', () => {
    installFakeEventSource();
    const events: SseChangeEvent[] = [];
    const dispose = connectSSE(event => events.push(event));
    const es = FakeEventSource.instances[0]!;
    assert.equal(es.url, '/api/events');
    assert.equal(events.length, 0);
    es.emit('hello', '{"revision":1}');
    es.emit('change', '{"type":"issue.updated","payload":{"id":"i1"},"revision":2,"at":""}');
    es.emit('change', '{"type":"comment.created","payload":{"id":"c1","issueId":"i1"},"revision":3,"at":""}');
    assert.deepEqual(events, [
      { type: 'hello', issueId: null },
      { type: 'issue.updated', issueId: 'i1' },
      { type: 'comment.created', issueId: 'i1' }
    ]);
    dispose();
    assert.equal(es.closed, true);
  });
});

describe('classifySseEvent', () => {
  it('routes project/directory events to the sidebar', () => {
    assert.equal(classifySseEvent('project.created'), 'projects');
    assert.equal(classifySseEvent('project.updated'), 'projects');
    assert.equal(classifySseEvent('directory.deleted'), 'projects');
  });

  it('routes issue/comment/dependency events to board data', () => {
    assert.equal(classifySseEvent('issue.updated'), 'issues');
    assert.equal(classifySseEvent('comment.created'), 'issues');
    assert.equal(classifySseEvent('dependency.changed'), 'issues');
  });

  it('routes hello and unknown types to both sides', () => {
    assert.equal(classifySseEvent('hello'), 'both');
    assert.equal(classifySseEvent(''), 'both');
    assert.equal(classifySseEvent('something.new'), 'both');
  });
});

describe('affectsOpenIssue', () => {
  it('only matches the open issue, or hello while a drawer is open', () => {
    assert.equal(affectsOpenIssue({ type: 'issue.updated', issueId: 'i1' }, null), false);
    assert.equal(affectsOpenIssue({ type: 'issue.updated', issueId: 'i1' }, 'i1'), true);
    assert.equal(affectsOpenIssue({ type: 'issue.updated', issueId: 'i2' }, 'i1'), false);
    assert.equal(affectsOpenIssue({ type: 'hello', issueId: null }, 'i1'), true);
    assert.equal(affectsOpenIssue({ type: 'hello', issueId: null }, null), false);
  });
});

describe('createSseBatcher', () => {
  const tracker = (): { calls: { projects: number; issues: number; detail: number } } => ({
    calls: { projects: 0, issues: 0, detail: 0 }
  });

  it('collapses a burst into at most one callback per handler', async () => {
    const { calls } = tracker();
    const batcher = createSseBatcher({
      onProjects: () => { calls.projects += 1; },
      onIssues: () => { calls.issues += 1; },
      onDetail: () => { calls.detail += 1; }
    }, 20);
    batcher.push({ type: 'issue.updated', issueId: 'i1' }, 'i1');
    batcher.push({ type: 'comment.created', issueId: 'i1' }, 'i1');
    batcher.push({ type: 'project.updated', issueId: null }, 'i1');
    await wait(60);
    assert.deepEqual(calls, { projects: 1, issues: 1, detail: 1 });
    batcher.dispose();
  });

  it('does not refetch unrelated data for project-only or issue-only events', async () => {
    const { calls } = tracker();
    const batcher = createSseBatcher({
      onProjects: () => { calls.projects += 1; },
      onIssues: () => { calls.issues += 1; },
      onDetail: () => { calls.detail += 1; }
    }, 20);
    batcher.push({ type: 'project.created', issueId: null }, null);
    await wait(60);
    assert.deepEqual(calls, { projects: 1, issues: 0, detail: 0 });
    batcher.push({ type: 'issue.updated', issueId: 'i2' }, 'i1');
    await wait(60);
    assert.deepEqual(calls, { projects: 1, issues: 1, detail: 0 });
    batcher.dispose();
  });

  it('refreshes everything including the open drawer on hello', async () => {
    const { calls } = tracker();
    const batcher = createSseBatcher({
      onProjects: () => { calls.projects += 1; },
      onIssues: () => { calls.issues += 1; },
      onDetail: () => { calls.detail += 1; }
    }, 20);
    batcher.push({ type: 'hello', issueId: null }, 'i1');
    await wait(60);
    assert.deepEqual(calls, { projects: 1, issues: 1, detail: 1 });
    batcher.dispose();
  });
});
