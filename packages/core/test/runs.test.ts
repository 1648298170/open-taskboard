// AgentRun domain model tests (Q1): state machine CAS, idempotency, retry
// chain, event dedupe/ordering, atomic claim, creation validation. Runs
// against the SOURCE barrel with an in-memory DatabaseSync, matching
// wake-claim.test.ts.

import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError, NotFoundError, Store, ValidationError, canTransitionRun } from '../src/index.js';

function fixture(): { store: Store; db: DatabaseSync; issueId: string } {
  const db = new DatabaseSync(':memory:');
  const store = new Store('.unused', db);
  store.createProject({ id: 'p1', name: 'P', defaultSessionId: 'ses-1' });
  const issueId = store.createIssue({ projectId: 'p1', title: 'run target' }).id;
  return { store, db, issueId };
}

describe('AgentRun domain model (Q1)', () => {
  it('creates a run persisting all inputs (matrix 1)', () => {
    const { store, issueId } = fixture();
    const run = store.createAgentRun(issueId, { prompt: 'do the thing', idempotencyKey: 'k1', sourceType: 'manual', priority: 5 });
    assert.equal(run.issueId, issueId);
    assert.equal(run.status, 'queued');
    assert.equal(run.attemptNo, 1);
    assert.equal(run.previousRunId, null);
    assert.equal(run.idempotencyKey, 'k1');
    assert.equal(run.sourceType, 'manual');
    assert.equal(run.priority, 5);
    assert.ok(run.promptSnapshot.includes('do the thing'));
    assert.equal(run.providerType, 'opencode');
    assert.equal(run.interactionMode, 'existing-session');
  });

  it('same idempotency key returns the same run without a duplicate (matrix 2)', () => {
    const { store, issueId } = fixture();
    const a = store.createAgentRun(issueId, { prompt: 'x', idempotencyKey: 'dup' });
    const b = store.createAgentRun(issueId, { prompt: 'y', idempotencyKey: 'dup' });
    assert.equal(a.id, b.id);
    assert.equal(store.listAgentRunsByIssue(issueId).items.length, 1);
  });

  it('retry creates a child run on the attempt chain and preserves terminal history (matrix 3/4)', () => {
    const { store, issueId } = fixture();
    const r1 = store.createAgentRun(issueId, { prompt: 'x', idempotencyKey: 'a1' });
    store.transitionRun(r1.id, 'starting');
    store.transitionRun(r1.id, 'failed', { errorCode: 'X', errorMessage: 'boom' });
    const r2 = store.retryAgentRun(r1.id);
    assert.equal(r2.previousRunId, r1.id);
    assert.equal(r2.attemptNo, 2);
    assert.notEqual(r2.id, r1.id);
    assert.equal(r2.status, 'queued');
    // original run untouched — history is never reused in place
    const r1After = store.getAgentRun(r1.id)!;
    assert.equal(r1After.status, 'failed');
    assert.equal(r1After.errorCode, 'X');
    assert.equal(r1After.finishedAt, null);
    // deterministic retry key: double retry returns the same child, not a third run
    const r2b = store.retryAgentRun(r1.id);
    assert.equal(r2b.id, r2.id);
  });

  it('rejects illegal transitions and terminal overwrites by late events (matrix 5)', () => {
    const { store, issueId } = fixture();
    const run = store.createAgentRun(issueId, { prompt: 'x', idempotencyKey: 't1' });
    assert.throws(() => store.transitionRun(run.id, 'succeeded'), ValidationError); // queued -> succeeded
    assert.throws(() => store.transitionRun(run.id, 'queued'), ValidationError); // self-transition
    store.transitionRun(run.id, 'starting');
    store.transitionRun(run.id, 'running');
    store.transitionRun(run.id, 'succeeded', { resultSummary: 'done it' });
    // terminal has no outgoing edges — late events cannot overwrite
    assert.throws(() => store.transitionRun(run.id, 'running'), ValidationError);
    assert.throws(() => store.transitionRun(run.id, 'failed'), ValidationError);
    const terminal = store.getAgentRun(run.id)!;
    assert.equal(terminal.status, 'succeeded');
    assert.equal(terminal.resultSummary, 'done it');
  });

  it('maps concurrent CAS miss to ConflictError (matrix 5)', () => {
    const { store, issueId } = fixture();
    const run = store.createAgentRun(issueId, { prompt: 'x', idempotencyKey: 'c1' });
    store.transitionRun(run.id, 'starting');
    store.transitionRun(run.id, 'running'); // concurrent winner
    // starting -> failed is legal from the STALE status, but the row moved on
    assert.throws(
      () => store.transitionRun(run.id, 'failed', {}, { expectedStatus: 'starting' }),
      ConflictError,
    );
    // legal transition from the current status still works after re-read
    const updated = store.transitionRun(run.id, 'succeeded', { resultSummary: 'ok' });
    assert.equal(updated.status, 'succeeded');
  });

  it('dedupes events by eventId, keeps sequence monotonic, pages by cursor (matrix 6)', () => {
    const { store, issueId } = fixture();
    const run = store.createAgentRun(issueId, { prompt: 'x', idempotencyKey: 'e1' });
    const e1 = store.appendRunEvent(run.id, 'evt-1', 'queued', { a: 1 });
    assert.ok(e1);
    assert.equal(e1.sequence, 1);
    assert.equal(store.appendRunEvent(run.id, 'evt-1', 'queued'), null, 'duplicate eventId must dedupe');
    const e2 = store.appendRunEvent(run.id, 'evt-2', 'claimed');
    assert.ok(e2);
    assert.equal(e2.sequence, 2);
    const page1 = store.listRunEvents(run.id, 0, 1);
    assert.equal(page1.length, 1);
    assert.equal(page1[0].eventId, 'evt-1');
    const page2 = store.listRunEvents(run.id, page1[0]!.sequence, 10);
    assert.equal(page2.length, 1);
    assert.equal(page2[0]!.eventId, 'evt-2');
    assert.throws(() => store.appendRunEvent('ghost', 'x', 'queued'), NotFoundError);
    assert.throws(() => store.listRunEvents('ghost'), NotFoundError);
  });

  it('claims FIFO across sessions; same-session runs serialize; not_before defers (matrix 7/9)', () => {
    const { store, issueId } = fixture();
    store.createProject({ id: 'p2', name: 'P2', defaultSessionId: 'ses-2' });
    const issue2 = store.createIssue({ projectId: 'p2', title: 'run target 2' }).id;
    const r1 = store.createAgentRun(issueId, { prompt: 'x', idempotencyKey: 'q1' });
    const r2 = store.createAgentRun(issue2, { prompt: 'y', idempotencyKey: 'q2' });
    const c1 = store.claimNextAgentRun('worker-1', 'engine-1');
    assert.ok(c1);
    assert.equal(c1.id, r1.id, 'FIFO: oldest queued first');
    assert.equal(c1.status, 'starting');
    assert.equal(c1.claimedBy, 'worker-1');
    // same-session candidate (ses-1 busy by c1) is deferred; the next
    // candidate on a different session still flows — busy must not block
    store.createAgentRun(issueId, { prompt: 'same session', idempotencyKey: 'q3' });
    const c2 = store.claimNextAgentRun('worker-2', 'engine-1');
    assert.ok(c2);
    assert.equal(c2.id, r2.id);
    assert.equal(store.claimNextAgentRun('worker-3', 'engine-1'), null, 'same-session candidate deferred, not claimed');
    // finish c2 → ses-2 free; a not_before run there still defers
    store.transitionRun(c2.id, 'running');
    store.transitionRun(c2.id, 'succeeded', { resultSummary: 'ok' });
    assert.ok(store.releaseAgentRunLease(c2.id, c2.dispatchId!), 'run lease must release on finalize');
    store.createAgentRun(issue2, { prompt: 'z', idempotencyKey: 'q4', notBefore: new Date(Date.now() + 3_600_000).toISOString() });
    assert.equal(store.claimNextAgentRun('worker-4', 'engine-1'), null, 'not_before defers');
    assert.throws(() => store.claimNextAgentRun('', 'engine-1'), ValidationError);
  });

  it('rejects creation on done/archived issues; in_review is allowed (matrix 36)', () => {
    const { store, db, issueId } = fixture();
    db.prepare('UPDATE issues SET status = ? WHERE id = ?').run('done', issueId);
    assert.throws(() => store.createAgentRun(issueId, { prompt: 'x' }), /ISSUE_NOT_EXECUTABLE/);
    db.prepare('UPDATE issues SET status = ?, archived_at = ? WHERE id = ?').run('todo', '2026-01-01T00:00:00Z', issueId);
    assert.throws(() => store.createAgentRun(issueId, { prompt: 'x' }), /ISSUE_ARCHIVED/);
    db.prepare('UPDATE issues SET status = ?, archived_at = NULL WHERE id = ?').run('in_review', issueId);
    const run = store.createAgentRun(issueId, { prompt: 'follow-up' });
    assert.equal(run.status, 'queued');
  });

  it('queue snapshot counts match view groups and filtering precedes pagination (matrix 32 core)', () => {
    const { store, issueId } = fixture();
    const r1 = store.createAgentRun(issueId, { prompt: 'x', idempotencyKey: 'v1' });
    store.createAgentRun(issueId, { prompt: 'y', idempotencyKey: 'v2' });
    store.transitionRun(r1.id, 'starting');
    const snap = store.listAgentRunsQueue({ view: 'queued' });
    assert.equal(snap.items.length, 1);
    assert.equal(snap.items[0]!.idempotencyKey, 'v2');
    assert.ok(snap.counts.queued >= 1);
    assert.ok(snap.counts.active >= 1);
    const limited = store.listAgentRunsQueue({ limit: 1 });
    assert.equal(limited.items.length, 1);
    assert.ok(limited.cursor);
    const page2 = store.listAgentRunsQueue({ limit: 1, cursor: limited.cursor! });
    assert.equal(page2.items.length, 1);
    assert.notEqual(page2.items[0]!.id, limited.items[0]!.id);
  });

  it('transition table sanity', () => {
    assert.ok(canTransitionRun('queued', 'starting'));
    assert.ok(canTransitionRun('cancel_requested', 'cancelled'));
    assert.ok(!canTransitionRun('succeeded', 'running'));
    assert.ok(!canTransitionRun('queued', 'succeeded'));
    assert.ok(!canTransitionRun('queued', 'queued'));
  });
});
