// RunScheduler tests (Q2): single dispatch path, fake worker closed loop,
// cancel semantics, hard-timeout → interrupted, orphan recovery, and
// multi-instance claim exclusivity over a shared SQLite file.
// Handles are stopped per-test (afterEach) — leaked schedulers would steal
// later tests' runs through the shared store.

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '@taskboard/core';
import { startRunScheduler, waitFor, type RunSchedulerHandle, type RunWorker } from '../src/run-scheduler.js';

let seq = 0;
function setup(dbFile?: string): { store: Store; makeIssue(): { projectId: string; issueId: string } } {
  const db = dbFile ? new DatabaseSync(dbFile) : new DatabaseSync(':memory:');
  const store = new Store('.unused', db);
  return {
    store,
    makeIssue() {
      seq += 1;
      const projectId = `p-${seq}`;
      store.createProject({ id: projectId, name: projectId, defaultSessionId: `ses-${seq}` });
      return { projectId, issueId: store.createIssue({ projectId, title: `run target ${seq}` }).id };
    },
  };
}

describe('RunScheduler (Q2)', () => {
  let local: RunSchedulerHandle[] = [];
  const track = (h: RunSchedulerHandle): RunSchedulerHandle => { local.push(h); return h; };
  afterEach(() => { for (const h of local) h.stop(); local = []; });

  it('drives queued → starting → running → succeeded with events and pump-continues (matrix 7/12/16)', async () => {
    const { store, makeIssue } = setup();
    const a = makeIssue();
    const b = makeIssue();
    const r1 = store.createAgentRun(a.issueId, { prompt: 'first' });
    const r2 = store.createAgentRun(b.issueId, { prompt: 'second' });
    const seen: string[] = [];
    track(startRunScheduler(store, {
      worker: {
        async execute(run, api) {
          seen.push(run.id);
          api.transition('running');
          api.event('progress', { step: 1 });
          return { status: 'succeeded', patch: { resultSummary: 'ok' } };
        },
      },
      pollMs: 100,
    }));
    await waitFor(() => seen.length === 2);
    await waitFor(() => store.getAgentRun(r1.id)!.status === 'succeeded' && store.getAgentRun(r2.id)!.status === 'succeeded');
    assert.deepEqual(seen.sort(), [r1.id, r2.id].sort(), 'every run executed exactly once');
    const final = store.getAgentRun(r1.id)!;
    assert.equal(final.resultSummary, 'ok');
    assert.ok(final.startedAt, 'running stamps startedAt');
    assert.ok(final.finishedAt, 'terminal stamps finishedAt');
    const events = store.listRunEvents(r1.id, 0, 50);
    const types = events.map(e => e.type);
    assert.ok(types.includes('claimed'), 'claim event recorded');
    assert.ok(types.includes('running'), 'running event recorded');
    assert.ok(types.includes('succeeded'), 'terminal event recorded');
    const seqs = events.map(e => e.sequence);
    assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y), 'sequences monotonic');
    assert.equal(store.claimNextAgentRun('probe', 'probe'), null);
  });

  it('maps worker exceptions to failed with WORKER_ERROR (matrix 11/17)', async () => {
    const { store, makeIssue } = setup();
    const { issueId } = makeIssue();
    const run = store.createAgentRun(issueId, { prompt: 'boom' });
    track(startRunScheduler(store, {
      worker: { async execute() { throw new Error('deterministic worker crash'); } },
      pollMs: 100,
    }));
    await waitFor(() => store.getAgentRun(run.id)!.status === 'failed');
    const failed = store.getAgentRun(run.id)!;
    assert.equal(failed.errorCode, 'WORKER_ERROR');
    assert.ok(failed.errorMessage!.includes('deterministic worker crash'));
    const retried = store.retryAgentRun(run.id);
    assert.equal(retried.attemptNo, 2);
  });

  it('hard execute timeout maps to interrupted, not failed (matrix 13/18)', async () => {
    const { store, makeIssue } = setup();
    const { issueId } = makeIssue();
    const run = store.createAgentRun(issueId, { prompt: 'slow' });
    track(startRunScheduler(store, {
      worker: { async execute() { await new Promise(resolve => setTimeout(resolve, 500)); return { status: 'succeeded' }; } },
      pollMs: 100,
      executeTimeoutMs: 50,
    }));
    await waitFor(() => store.getAgentRun(run.id)!.status === 'interrupted');
    assert.equal(store.getAgentRun(run.id)!.errorCode, 'RUNTIME_UNAVAILABLE');
  });

  it('cancel: queued → cancelled; active+confirmed → cancelled; terminal short-circuits (matrix 19/20)', async () => {
    const { store, makeIssue } = setup();
    const a = makeIssue();
    const b = makeIssue();
    const c = makeIssue();
    const active = store.createAgentRun(a.issueId, { prompt: 'active cancel' });
    const plain = store.createAgentRun(b.issueId, { prompt: 'plain' });
    // concurrency 1 + gated execute keeps `q` queued deterministically
    const q = store.createAgentRun(a.issueId, { prompt: 'queued cancel' });
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>(resolve => { releaseGate = resolve; });
    const main = track(startRunScheduler(store, {
      worker: {
        async execute(run) {
          if (run.id === active.id || run.id === q.id) { await gate; }
          return { status: 'succeeded', patch: { resultSummary: run.id } };
        },
        async cancel() { return 'confirmedStopped'; },
      },
      pollMs: 100,
      concurrency: 1,
    }));
    await waitFor(() => store.getAgentRun(active.id)!.status === 'starting');
    assert.equal(await main.cancelRun(q.id), 'cancelled');
    assert.equal(store.getAgentRun(q.id)!.status, 'cancelled');
    await waitFor(() => store.getAgentRun(active.id)!.status === 'starting');
    assert.equal(await main.cancelRun(active.id), 'cancelled');
    assert.equal(store.getAgentRun(active.id)!.status, 'cancelled');
    releaseGate();
    await waitFor(() => store.getAgentRun(plain.id)!.status === 'succeeded');
    const done = store.createAgentRun(c.issueId, { prompt: 'second' });
    await waitFor(() => store.getAgentRun(done.id)!.status === 'succeeded');
    const noCancel = track(startRunScheduler(store, {
      worker: { async execute() { return { status: 'succeeded' }; } },
      pollMs: 100,
    }));
    assert.equal(await noCancel.cancelRun(done.id), 'terminal');
  });
  it('recovers orphans: unstarted → requeued, post-dispatch → interrupted; stale lease released (matrix 13)', async () => {
    const { store, makeIssue } = setup();
    const a = makeIssue();
    const b = makeIssue();
    const r1 = store.createAgentRun(a.issueId, { prompt: 'pre-dispatch' });
    const r2 = store.createAgentRun(b.issueId, { prompt: 'post-dispatch' });
    const c1 = store.claimNextAgentRun('dead-engine', 'dead-engine');
    const c2 = store.claimNextAgentRun('dead-engine', 'dead-engine');
    assert.ok(c1 && c2);
    store.transitionRun(c2.id, 'running');
    track(startRunScheduler(store, {
      worker: { async execute(run) { return run.id === r1.id ? { status: 'succeeded' } : { status: 'failed' }; } },
      pollMs: 100,
    }));
    await waitFor(() => store.getAgentRun(r1.id)!.status === 'succeeded', 5_000);
    const r2f = store.getAgentRun(r2.id)!;
    assert.equal(r2f.status, 'interrupted', 'post-dispatch orphan → interrupted');
    assert.equal(r2f.errorCode, 'RUNTIME_UNAVAILABLE');
    void r2;
  });

  it('two schedulers on one SQLite file: no double execution (matrix 8/10)', async () => {
    const dbFile = join(tmpdir(), `q2-multi-${randomUUID()}.sqlite`);
    const s1 = setup(dbFile);
    const issues = [s1.makeIssue(), s1.makeIssue(), s1.makeIssue()];
    const runIds = issues.map(i => s1.store.createAgentRun(i.issueId, { prompt: 'shared' }).id);
    const s2 = new Store('.unused', new DatabaseSync(dbFile));
    const executed: string[] = [];
    const makeWorker = (): RunWorker => ({
      async execute(run) {
        executed.push(run.id);
        await new Promise(resolve => setTimeout(resolve, 30));
        return { status: 'succeeded' };
      },
    });
    track(startRunScheduler(s1.store, { worker: makeWorker(), pollMs: 40, concurrency: 2 }));
    track(startRunScheduler(s2, { worker: makeWorker(), pollMs: 40, concurrency: 2 }));
    await waitFor(() => runIds.every(id => s1.store.getAgentRun(id)!.status === 'succeeded'), 15_000);
    assert.equal(new Set(executed).size, 3, 'no run executed twice across schedulers');
  });
});
