// Engine behavior: claim-before-deliver, CAS revert, headless finalization,
// startup sweep, event subscription and queue serialization. Everything runs
// against an in-memory Store; OpenCode/TUI HTTP and the headless child process
// are injected fakes.

import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '@taskboard/core';
import {
  createWakeEngine,
  WATCH_REQUEST_TIMEOUT_MS,
  type SpawnFn,
  type WakeChildProcess,
  type WakeDeps,
  type WakeEngine,
  type WakeEngineOptions,
} from '../src/index.js';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.fail('condition was not met before timeout');
}

interface Fixture {
  store: Store;
  db: DatabaseSync;
  issueId: string;
  engine: WakeEngine;
  fetchCalls: string[];
  logs: { message: string; level?: string }[];
}

function fixture(options: {
  sessionId?: string | null;
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  spawn?: SpawnFn;
  engineAlreadyStarted?: boolean;
  config?: Partial<WakeDeps['config']>;
  engineOptions?: WakeEngineOptions;
  wrapStore?: (store: Store) => Store;
}): Fixture {
  const db = new DatabaseSync(':memory:');
  const store = new Store('.unused', db);
  store.createProject({ id: 'p1', name: 'P', defaultSessionId: options.sessionId ?? null });
  const issueId = store.createIssue({ projectId: 'p1', title: 'Hero task' }).id;
  const fetchCalls: string[] = [];
  const logs: { message: string; level?: string }[] = [];
  const deps: WakeDeps = {
    store: options.wrapStore ? options.wrapStore(store) : store,
    fetchImpl: (url, init) => {
      fetchCalls.push(String(url));
      return options.fetchImpl(String(url), init);
    },
    spawn: options.spawn ?? failingSpawn(),
    randomUUID: () => 'engine-uuid',
    homedir: () => process.cwd(),
    platform: process.platform,
    env: {},
    log: (message, level) => logs.push({ message, level }),
    requestTimeoutMs: WATCH_REQUEST_TIMEOUT_MS,
    config: {
      prefix: '@agent',
      opencodeBase: 'http://oc.test',
      execParts: ['opencode', 'run'],
      ignoreAuthors: new Set(['watch']),
      ...options.config,
    },
  };
  const engine = createWakeEngine(deps, options.engineOptions);
  return { store, db, issueId, engine, fetchCalls, logs };
}

const okResponse = (): Promise<Response> => Promise.resolve(new Response('{}', { status: 200 }));
const healthOk = (url: string): Promise<Response> | undefined =>
  url.endsWith('/global/health') ? okResponse() : undefined;

function failingSpawn(): SpawnFn {
  return () => failingChild();
}

function failingChild(): WakeChildProcess {
  const child: WakeChildProcess = {
    on(event, listener) {
      if (event === 'exit') queueMicrotask(() => (listener as (code: number | null) => void)(1));
      return child;
    },
  };
  return child;
}

function exitZeroSpawn(onSpawn?: () => void): SpawnFn {
  return () => {
    onSpawn?.();
    const child: WakeChildProcess = {
      on(event, listener) {
        if (event === 'exit') queueMicrotask(() => (listener as (code: number | null) => void)(0));
        return child;
      },
    };
    return child;
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('wake engine: claim-before-deliver', () => {
  it('marks the comment processing (with a claim token) before prompt_async fires', async () => {
    let statusAtPrompt = '';
    let tokenAtPrompt = '';
    const { store, db, issueId, engine } = fixture({
      sessionId: 'ses_1',
      fetchImpl: url => {
        const health = healthOk(url);
        if (health) return health;
        if (url.includes('/prompt_async')) {
          statusAtPrompt = store.getComment(commentId)!.status;
          tokenAtPrompt = (db.prepare('SELECT claimed_by AS token FROM comments WHERE id = ?').get(commentId) as { token: string }).token;
          return okResponse();
        }
        return okResponse();
      },
    });
    let commentId = '';
    await engine.start();
    try {
      commentId = store.addComment(issueId, { author: 'web', body: '@agent 处理这个' }).id;
      await waitFor(() => statusAtPrompt !== '');
      assert.equal(statusAtPrompt, 'processing');
      assert.ok(tokenAtPrompt.length > 0, 'a per-attempt claim token must be stored');
      // prompt_async acceptance keeps 'processing' for the agent to finalize.
      assert.equal(store.getComment(commentId)!.status, 'processing');
    } finally {
      await engine.stop();
    }
  });
});

describe('wake engine: delivery failure', () => {
  it('reverts the claim to pending when prompt delivery is rejected', async () => {
    let promptAttempted = false;
    const { store, db, issueId, engine } = fixture({
      sessionId: 'ses_1',
      fetchImpl: url => {
        const health = healthOk(url);
        if (health) return health;
        if (url.includes('/prompt_async')) {
          promptAttempted = true;
          return Promise.resolve(new Response('nope', { status: 500 }));
        }
        return okResponse();
      },
    });
    await engine.start();
    try {
      const commentId = store.addComment(issueId, { author: 'web', body: '@agent 处理这个' }).id;
      // Wait for the whole attempt: the initial row is pending too, so the
      // predicate must prove delivery already ran and was reverted.
      await waitFor(() => promptAttempted
        && (db.prepare('SELECT status FROM comments WHERE id = ?').get(commentId) as { status: string }).status === 'pending');
      const row = db.prepare('SELECT status, claimed_by AS token FROM comments WHERE id = ?').get(commentId) as { status: string; token: string };
      assert.equal(row.status, 'pending');
      assert.equal(row.token, '', 'released claims clear their token');
    } finally {
      await engine.stop();
    }
  });
});

describe('wake engine: headless finalization', () => {
  it('marks processed only after a headless exit-0, and claims before spawning', async () => {
    let statusAtSpawn = '';
    const { store, issueId, engine } = fixture({
      sessionId: null,
      fetchImpl: url => okResponse(),
      spawn: exitZeroSpawn(() => { statusAtSpawn = store.getComment(commentId)!.status; }),
    });
    let commentId = '';
    await engine.start();
    try {
      commentId = store.addComment(issueId, { author: 'web', body: '@agent 处理这个' }).id;
      await waitFor(() => store.getComment(commentId)!.status === 'processed');
      assert.equal(statusAtSpawn, 'processing');
    } finally {
      await engine.stop();
    }
  });
});

describe('wake engine: filtering', () => {
  it('ignores non-wake comments without calling any delivery channel', async () => {
    const { store, issueId, engine, fetchCalls } = fixture({
      sessionId: 'ses_1',
      fetchImpl: url => healthOk(url) ?? okResponse(),
    });
    await engine.start();
    try {
      const commentId = store.addComment(issueId, { author: 'web', body: '普通评论' }).id;
      await sleep(120);
      assert.equal(store.getComment(commentId)!.status, 'pending');
      assert.deepEqual(fetchCalls, []);
    } finally {
      await engine.stop();
    }
  });
});

describe('wake engine: startup sweep', () => {
  it('enqueues pre-existing pending wake comments on start()', async () => {
    let promptedIssue = '';
    const { store, issueId, engine } = fixture({
      sessionId: 'ses_1',
      fetchImpl: url => {
        const health = healthOk(url);
        if (health) return health;
        if (url.includes('/prompt_async')) {
          promptedIssue = issueId;
          return okResponse();
        }
        return okResponse();
      },
    });
    // Created BEFORE the engine starts — only the one-shot sweep can see it.
    const commentId = store.addComment(issueId, { author: 'web', body: '@agent 补做这个' }).id;
    await engine.start();
    try {
      await waitFor(() => promptedIssue !== '');
      assert.equal(store.getComment(commentId)!.status, 'processing');
    } finally {
      await engine.stop();
    }
  });
});

describe('wake engine: serialized queue', () => {
  it('does not start the second wake until the first delivery settles', async () => {
    const firstPrompt = deferred();
    let promptCount = 0;
    const { store, issueId, engine } = fixture({
      sessionId: 'ses_1',
      fetchImpl: url => {
        const health = healthOk(url);
        if (health) return health;
        if (url.includes('/prompt_async')) {
          promptCount++;
          if (promptCount === 1) return firstPrompt.promise.then(() => new Response('{}', { status: 200 }));
          return okResponse();
        }
        return okResponse();
      },
    });
    const secondIssue = store.createIssue({ projectId: 'p1', title: 'Second' }).id;
    await engine.start();
    try {
      store.addComment(issueId, { author: 'web', body: '@agent 第一条' });
      store.addComment(secondIssue, { author: 'web', body: '@agent 第二条' });
      await waitFor(() => promptCount === 1);
      await sleep(80);
      assert.equal(promptCount, 1, 'the second wake must wait for the first');

      firstPrompt.resolve();
      await waitFor(() => promptCount === 2);
    } finally {
      firstPrompt.resolve();
      await engine.stop();
    }
  });
});

describe('wake engine: periodic poll', () => {
  it('drains a pending wake inserted after start() without an event', async () => {
    const { store, db, issueId, engine, fetchCalls } = fixture({
      sessionId: 'ses_1',
      fetchImpl: url => healthOk(url) ?? okResponse(),
      engineOptions: { pollMs: 20 },
    });
    await engine.start();
    try {
      // Direct insert bypasses Store.addComment, so the event subscription can
      // never see it — only the periodic sweep can deliver this wake.
      const t = new Date().toISOString();
      db.prepare(
        'INSERT INTO comments (id, issue_id, author, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('poll-comment', issueId, 'web', '@agent 轮询补拉', t, t);

      await waitFor(() => store.getComment('poll-comment')!.status === 'processing');
      assert.ok(fetchCalls.some(url => url.includes('/prompt_async')), 'the polled wake must reach prompt_async');
    } finally {
      await engine.stop();
    }
  });
});

describe('wake engine: fault isolation', () => {
  it('logs a throwing event path and keeps delivering later wakes', async () => {
    let failNext = true;
    const { store, issueId, engine, logs } = fixture({
      sessionId: 'ses_1',
      fetchImpl: url => healthOk(url) ?? okResponse(),
      wrapStore: base => {
        const flaky = Object.create(base) as Store;
        flaky.getIssue = (id: string) => {
          if (failNext) {
            failNext = false;
            throw new Error('boom');
          }
          return base.getIssue(id);
        };
        return flaky;
      },
    });
    await engine.start();
    try {
      // A throwing third-party listener must not stop the emitter either.
      const unsubscribe = store.subscribe(() => { throw new Error('listener boom'); });
      const broken = store.addComment(issueId, { author: 'web', body: '@agent 第一条' }).id;
      unsubscribe();

      await waitFor(() => logs.some(entry => entry.message.includes('event handling failed')));
      assert.equal(store.getComment(broken)!.status, 'pending');

      const delivered = store.addComment(issueId, { author: 'web', body: '@agent 第二条' }).id;
      await waitFor(() => store.getComment(delivered)!.status === 'processing');
      assert.equal(engine.isRunning(), true);
    } finally {
      await engine.stop();
    }
  });
});

describe('wake engine: embedded mode', () => {
  it('never spawns and leaves unbound wakes pending for the external sidecar', async () => {
    let spawned = 0;
    const { store, issueId, engine, logs } = fixture({
      sessionId: null,
      fetchImpl: () => okResponse(),
      spawn: () => {
        spawned++;
        return failingChild();
      },
      config: { execParts: undefined },
    });
    await engine.start();
    try {
      const commentId = store.addComment(issueId, { author: 'web', body: '@agent 无绑定任务' }).id;
      await waitFor(() => logs.some(entry => entry.message.includes('leaving wake pending for the external sidecar')));
      assert.equal(spawned, 0, 'the embedded engine must never spawn a new session');
      // Not claimed at all: a coexisting `taskboard watch` can still take it.
      assert.equal(store.getComment(commentId)!.status, 'pending');
    } finally {
      await engine.stop();
    }
  });
});

describe('wake engine: channel watchdog', () => {
  it('logs WARN once while OpenCode is unreachable and RECOVERED once when it returns', async () => {
    let healthy = false;
    const { engine, logs } = fixture({
      sessionId: null,
      fetchImpl: () => {
        if (!healthy) throw new Error('ECONNREFUSED');
        return okResponse();
      },
      config: { execParts: undefined },
      engineOptions: { pollMs: 25 },
    });
    await engine.start();
    try {
      await waitFor(() => logs.some(entry => entry.message.includes('WARN opencode unreachable')));
      // Repeated failing polls must not spam the log.
      await sleep(90);
      const warns = logs.filter(entry => entry.message.includes('WARN opencode unreachable'));
      assert.equal(warns.length, 1, 'WARN should be logged only on the healthy→down transition');
      assert.equal(warns[0].level, 'error');

      healthy = true;
      await waitFor(() => logs.some(entry => entry.message.includes('RECOVERED opencode reachable')));
      await sleep(90);
      const recovered = logs.filter(entry => entry.message.includes('RECOVERED opencode reachable'));
      assert.equal(recovered.length, 1, 'RECOVERED should be logged only on the down→healthy transition');
    } finally {
      await engine.stop();
    }
  });
});

describe('wake engine: long instruction', () => {
  it('delivers the FULL comment body even though the event payload truncates to 200 chars', async () => {
    const tail = 'END-MARKER-请保留这段超过两百字符的尾部指令';
    const longBody = `@agent ${'很长的指令内容。'.repeat(30)}${tail}`;
    assert.ok(longBody.length > 200, 'test body must exceed the 200-char event slice');
    let lastPromptBody = '';
    const { store, issueId, engine, fetchCalls } = fixture({
      sessionId: 'ses_x',
      fetchImpl: (_url, init) => {
        if (init?.body) lastPromptBody = String(init.body);
        return okResponse();
      },
    });
    const promptDeliveries = (): number => fetchCalls.filter(u => u.includes('/prompt_async')).length;
    await engine.start();
    try {
      const commentId = store.addComment(issueId, { author: 'web', body: longBody }).id;
      await waitFor(() => promptDeliveries() >= 1);
      await waitFor(() => store.getComment(commentId)!.status === 'processing');
      // 事件载荷只有 200 字符；投递出的 prompt 必须包含尾部标记 = 用了全量 body。
      assert.ok(lastPromptBody.includes(tail), 'prompt must contain the full instruction tail');
    } finally {
      await engine.stop();
    }
  });
});

describe('wake engine: re-wake', () => {
  it('a pending status patch re-delivers an already processed wake comment', async () => {
    const { store, issueId, engine, fetchCalls } = fixture({
      sessionId: 'ses_x',
      fetchImpl: () => okResponse(),
    });
    const promptDeliveries = (): number => fetchCalls.filter(u => u.includes('/prompt_async')).length;
    await engine.start();
    try {
      const commentId = store.addComment(issueId, { author: 'web', body: '@agent 第一轮' }).id;
      await waitFor(() => promptDeliveries() >= 1);
      await waitFor(() => store.getComment(commentId)!.status === 'processing');
      assert.equal(promptDeliveries(), 1);
      // 重新唤醒：pending 状态补丁必须穿透 seen 去重并再次投递。
      // 注：prompt_async 路径在 stub 下不会到 processed（monitor 无完成信号），
      // 所以重投递的断言是「prompt 再次发生 + 重新认领为 processing」。
      store.updateComment(commentId, { status: 'pending' });
      await waitFor(() => promptDeliveries() >= 2);
      await waitFor(() => store.getComment(commentId)!.status === 'processing');
    } finally {
      await engine.stop();
    }
  });
});
