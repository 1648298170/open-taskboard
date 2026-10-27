// Q5 route tests: agent-run REST surface over the real startServer app
// (fastify inject). Engine kept off — routes are pure Store projections.

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '@taskboard/core';
import { startServer } from '../src/server.js';

async function makeServer() {
  const dir = mkdtempSync(join(tmpdir(), 'tb-runs-'));
  const db = new DatabaseSync(':memory:');
  const store = new Store(dir, db);
  store.createProject({ id: 'p1', name: 'P', defaultSessionId: 'ses-1', workspacePath: 'D:/ws' });
  const issueId = store.createIssue({ projectId: 'p1', title: 'run target' }).id;
  const { app } = await startServer({
    host: '127.0.0.1',
    port: 0,
    dataDir: dir,
    store,
    env: { TASKBOARD_BACKUPS: '0', TASKBOARD_WAKE_EMBEDDED: '0' },
  });
  return {
    app, store, issueId,
    cleanup: async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

describe('agent-run routes (Q5)', () => {
  it('POST create → 202 queued; idempotency key returns the same run', async () => {
    const f = await makeServer();
    try {
      const first = await f.app.inject({ method: 'POST', url: `/api/issues/${f.issueId}/agent-runs`, payload: { prompt: 'go', idempotencyKey: 'idem-1' } });
      assert.equal(first.statusCode, 202);
      const body = first.json();
      assert.equal(body.status, 'queued');
      const second = await f.app.inject({ method: 'POST', url: `/api/issues/${f.issueId}/agent-runs`, payload: { prompt: 'go again', idempotencyKey: 'idem-1' } });
      assert.equal(second.statusCode, 202);
      assert.equal(second.json().runId, body.runId, 'same key must reuse the run');
      const history = await f.app.inject({ method: 'GET', url: `/api/issues/${f.issueId}/agent-runs` });
      assert.equal(history.json().items.length, 1);
    } finally { await f.cleanup(); }
  });

  it('create on missing/done issue → 404/400 with stable codes (matrix 36)', async () => {
    const f = await makeServer();
    try {
      const missing = await f.app.inject({ method: 'POST', url: '/api/issues/ghost/agent-runs', payload: { prompt: 'x' } });
      assert.equal(missing.statusCode, 404);
      assert.equal(missing.json().code, 'ISSUE_NOT_FOUND');
      f.store.getIssue;
      await f.app.inject({ method: 'POST', url: `/api/issues/${f.issueId}/agent-runs`, payload: { prompt: 'x' } });
      // flip to done through the raw table (route-layer gate is the API contract)
      const db = (f.store as unknown as { db: DatabaseSync }).db;
      db.prepare('UPDATE issues SET status = ? WHERE id = ?').run('done', f.issueId);
      const done = await f.app.inject({ method: 'POST', url: `/api/issues/${f.issueId}/agent-runs`, payload: { prompt: 'x' } });
      assert.equal(done.statusCode, 400);
      assert.equal(done.json().code, 'ISSUE_NOT_EXECUTABLE');
    } finally { await f.cleanup(); }
  });

  it('queue center: counts + view filtering; run detail capabilities (matrix 32/35)', async () => {
    const f = await makeServer();
    try {
      const created = await f.app.inject({ method: 'POST', url: `/api/issues/${f.issueId}/agent-runs`, payload: { prompt: 'x' } });
      const runId = created.json().runId;
      const center = await f.app.inject({ method: 'GET', url: '/api/agent-runs?view=queued' });
      assert.equal(center.statusCode, 200);
      assert.ok(center.json().counts.queued >= 1);
      assert.equal(center.json().items.length, 1);
      const active = await f.app.inject({ method: 'GET', url: '/api/agent-runs?view=active' });
      assert.equal(active.json().items.length, 0, 'queued run is not active');
      const detail = await f.app.inject({ method: 'GET', url: `/api/agent-runs/${runId}` });
      assert.equal(detail.statusCode, 200);
      assert.equal(detail.json().capabilities.cancel, true);
      assert.equal(detail.json().capabilities.retry, false);
      assert.equal(detail.json().capabilities.messages, false, 'unproven capability stays false');
    } finally { await f.cleanup(); }
  });

  it('cancel queued → cancelled; re-cancel → 409 RUN_ALREADY_TERMINAL (matrix 19/20 API)', async () => {
    const f = await makeServer();
    try {
      const created = await f.app.inject({ method: 'POST', url: `/api/issues/${f.issueId}/agent-runs`, payload: { prompt: 'x' } });
      const runId = created.json().runId;
      const cancel = await f.app.inject({ method: 'POST', url: `/api/agent-runs/${runId}/cancel` });
      assert.equal(cancel.statusCode, 200);
      assert.equal(cancel.json().result, 'cancelled');
      const again = await f.app.inject({ method: 'POST', url: `/api/agent-runs/${runId}/cancel` });
      assert.equal(again.statusCode, 409);
      assert.equal(again.json().code, 'RUN_ALREADY_TERMINAL');
    } finally { await f.cleanup(); }
  });

  it('retry failed run → 202 child attemptNo 2 (matrix 4 API)', async () => {
    const f = await makeServer();
    try {
      const created = await f.app.inject({ method: 'POST', url: `/api/issues/${f.issueId}/agent-runs`, payload: { prompt: 'x' } });
      const runId = created.json().runId;
      f.store.transitionRun(runId, 'starting');
      f.store.transitionRun(runId, 'failed', { errorCode: 'X' });
      const retry = await f.app.inject({ method: 'POST', url: `/api/agent-runs/${runId}/retry` });
      assert.equal(retry.statusCode, 202);
      assert.equal(retry.json().attemptNo, 2);
      const history = await f.app.inject({ method: 'GET', url: `/api/issues/${f.issueId}/agent-runs` });
      assert.equal(history.json().items.length, 2, 'both runs kept');
    } finally { await f.cleanup(); }
  });

  it('events endpoint paginates; unknown run → 404 RUN_NOT_FOUND (matrix 33 core)', async () => {
    const f = await makeServer();
    try {
      const missing = await f.app.inject({ method: 'GET', url: '/api/agent-runs/ghost/events' });
      assert.equal(missing.statusCode, 404);
      assert.equal(missing.json().code, 'RUN_NOT_FOUND');
      const created = await f.app.inject({ method: 'POST', url: `/api/issues/${f.issueId}/agent-runs`, payload: { prompt: 'x' } });
      const runId = created.json().runId;
      f.store.appendRunEvent(runId, 'e1', 'queued');
      f.store.appendRunEvent(runId, 'e2', 'claimed');
      const page = await f.app.inject({ method: 'GET', url: `/api/agent-runs/${runId}/events?afterSequence=0&limit=1` });
      assert.equal(page.json().events.length, 1);
      const page2 = await f.app.inject({ method: 'GET', url: `/api/agent-runs/${runId}/events?afterSequence=1&limit=10` });
      assert.equal(page2.json().events.length, 1);
      assert.equal(page2.json().events[0].eventId, 'e2');
    } finally { await f.cleanup(); }
  });
});
