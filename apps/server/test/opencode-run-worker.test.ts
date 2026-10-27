// OpenCode RunWorker (Q3): marker-correlated dispatch over a local mock of
// the OpenCode session API. Covers the §9.2 invariants: probe before send,
// 2xx ≠ succeeded, 4xx deterministic, 5xx unknown → interrupted without
// blind resend, busy/paths fail-closed, abort → confirmedStopped.

import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '@taskboard/core';
import type { RunWorkerApi } from '@taskboard/wake';
import { createOpenCodeRunWorker } from '../src/opencode-run-worker.js';

interface MockState {
  statusType: string;
  promptCalls: number;
  promptStatus: number;
  abortCalls: number;
  messages: unknown[];
  assistantText: string | null;
}

function setup() {
  const state: MockState = {
    statusType: 'idle',
    promptCalls: 0,
    promptStatus: 200,
    abortCalls: 0,
    messages: [],
    assistantText: 'all done',
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (code: number, body?: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (req.method === 'POST' && url.pathname.endsWith('/prompt_async')) {
      state.promptCalls += 1;
      if (state.promptStatus !== 200) { send(state.promptStatus); return; }
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        const text = String((JSON.parse(raw).parts ?? [{}])[0]?.text ?? '');
        const created = Date.now();
        const promptId = `u${state.promptCalls}`;
        state.messages.push({ info: { role: 'user', id: promptId, time: { created } }, parts: [{ type: 'text', text }] });
        if (state.assistantText !== null) {
          state.messages.push({
            info: { role: 'assistant', parentID: promptId, time: { created: created + 1 } },
            parts: [{ type: 'text', text: state.assistantText }],
          });
        }
        send(200, { id: 'ack' });
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/session/status') {
      send(200, { 'ses-1': { type: state.statusType } });
      return;
    }
    if (req.method === 'GET' && url.pathname.endsWith('/message')) {
      send(200, state.messages);
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/session/')) {
      send(200, { id: 'ses-1', directory: '', time: {} });
      return;
    }
    if (req.method === 'POST' && url.pathname.endsWith('/abort')) {
      state.abortCalls += 1;
      send(204);
      return;
    }
    send(404);
  });
  return new Promise<{ state: MockState; serverUrl: string; close: () => void }>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ state, serverUrl: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

function board(workspacePath = 'D:/ws') {
  const store = new Store('.unused', new DatabaseSync(':memory:'));
  store.createProject({ id: 'p1', name: 'P', defaultSessionId: 'ses-1', workspacePath });
  const issueId = store.createIssue({ projectId: 'p1', title: 'run target' }).id;
  return { store, issueId };
}

function claimedRun(store: ReturnType<typeof board>['store'], issueId: string) {
  store.createAgentRun(issueId, { prompt: 'do the work', idempotencyKey: `k-${issueId}` });
  const claimed = store.claimNextAgentRun('worker-1', 'engine-1');
  assert.ok(claimed, 'claim must succeed in fixture');
  return claimed;
}

const stubApi = (log: string[]): RunWorkerApi => ({
  transition(to) { log.push(`transition:${to}`); },
  event(type) { log.push(`event:${type}`); },
});

describe('OpenCodeRunWorker (Q3)', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { for (const c of cleanups.splice(0)) c(); });

  it('full loop: probe → send → running evidence → correlated succeeded (matrix 14/16)', async () => {
    const { state, serverUrl, close } = await setup();
    cleanups.push(close);
    const { store, issueId } = board();
    const claimed = claimedRun(store, issueId);
    const log: string[] = [];
    const worker = createOpenCodeRunWorker(store, { serverUrl, pollIntervalMs: 20, busyWaitTimeoutMs: 200, evidenceTimeoutMs: 2_000 });
    const outcome = await worker.execute(claimed!, stubApi(log));
    assert.equal(outcome.status, 'succeeded');
    assert.equal(outcome.patch?.resultSummary, 'all done');
    assert.equal(state.promptCalls, 1);
    assert.ok(log.includes('transition:running'), 'running before terminal');
    assert.ok(log.includes('event:prompt_sent'));
    const run = store.getAgentRun(claimed!.id)!;
    assert.equal(run.status, 'starting'); // scheduler applies outcomes; direct execute only probes
    void run;
  });

  it('4xx → failed deterministic; exactly one send (matrix 17)', async () => {
    const { state, serverUrl, close } = await setup();
    cleanups.push(close);
    state.promptStatus = 404;
    const { store, issueId } = board();
    const claimed = claimedRun(store, issueId);
    const worker = createOpenCodeRunWorker(store, { serverUrl, pollIntervalMs: 20 });
    const outcome = await worker.execute(claimed!, stubApi([]));
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.patch?.errorCode, 'OPENCODE_REJECTED');
    assert.equal(state.promptCalls, 1, '4xx is deterministic — no resend');
  });

  it('5xx → interrupted unknown; no blind resend (matrix 17/18)', async () => {
    const { state, serverUrl, close } = await setup();
    cleanups.push(close);
    state.promptStatus = 500;
    const { store, issueId } = board();
    const claimed = claimedRun(store, issueId);
    const worker = createOpenCodeRunWorker(store, { serverUrl, pollIntervalMs: 20 });
    const outcome = await worker.execute(claimed!, stubApi([]));
    assert.equal(outcome.status, 'interrupted');
    assert.equal(outcome.patch?.errorCode, 'RUNTIME_UNAVAILABLE');
    assert.equal(state.promptCalls, 1, 'unknown outcome must not trigger a second send');
  });

  it('busy session past wait window → failed RESOURCE_BUSY; zero sends (matrix 15)', async () => {
    const { state, serverUrl, close } = await setup();
    cleanups.push(close);
    state.statusType = 'busy';
    const { store, issueId } = board();
    const claimed = claimedRun(store, issueId);
    const worker = createOpenCodeRunWorker(store, { serverUrl, pollIntervalMs: 20, busyWaitTimeoutMs: 120 });
    const outcome = await worker.execute(claimed!, stubApi([]));
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.patch?.errorCode, 'RESOURCE_BUSY');
    assert.equal(state.promptCalls, 0, 'never send into a busy session');
  });

  it('workspace snapshot mismatch → failed fail-closed; zero sends (matrix 15)', async () => {
    const { state, serverUrl, close } = await setup();
    cleanups.push(close);
    const { store, issueId } = board('D:/ws');
    const claimed = claimedRun(store, issueId);
    // workspacePath lives on the Directory; projects inherit it
    const project = store.getProject('p1');
    assert.ok(project?.directoryId, 'fixture project must carry a directory');
    store.updateDirectory(project.directoryId, { workspacePath: 'D:/elsewhere' });
    const worker = createOpenCodeRunWorker(store, { serverUrl, pollIntervalMs: 20 });
    const outcome = await worker.execute(claimed!, stubApi([]));
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.patch?.errorCode, 'SESSION_WORKSPACE_MISMATCH');
    assert.equal(state.promptCalls, 0);
  });

  it('2xx without correlated evidence → interrupted within the window (matrix 16)', async () => {
    const { state, serverUrl, close } = await setup();
    cleanups.push(close);
    state.assistantText = null; // agent acked the prompt but never replied
    const { store, issueId } = board();
    const claimed = claimedRun(store, issueId);
    const worker = createOpenCodeRunWorker(store, { serverUrl, pollIntervalMs: 20, evidenceTimeoutMs: 300 });
    const outcome = await worker.execute(claimed!, stubApi([]));
    assert.equal(outcome.status, 'interrupted');
    assert.equal(outcome.patch?.errorCode, 'RUNTIME_UNAVAILABLE');
    assert.equal(state.promptCalls, 1, 'no resend on missing evidence');
  });

  it('cancel → abort confirmedStopped (matrix 19)', async () => {
    const { state, serverUrl, close } = await setup();
    cleanups.push(close);
    const { store, issueId } = board();
    const claimed = claimedRun(store, issueId);
    const worker = createOpenCodeRunWorker(store, { serverUrl });
    assert.equal(await worker.cancel(claimed!), 'confirmedStopped');
    assert.equal(state.abortCalls, 1);
  });
});
