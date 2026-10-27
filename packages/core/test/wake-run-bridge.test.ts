// Q4 @agent → Run bridge tests: token boundary, idempotent run creation,
// re-wake generations, de-wake cancellation, comment projection, and the
// legacy backfill scenarios (§12.4 matrix 21–31).

import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Store, isWakeComment } from '../src/index.js';

function fixture(): { store: Store; db: DatabaseSync; issueId: string } {
  const db = new DatabaseSync(':memory:');
  const store = new Store('.unused', db);
  store.createProject({ id: 'p1', name: 'P', defaultSessionId: 'ses-1', workspacePath: 'D:/ws' });
  const issueId = store.createIssue({ projectId: 'p1', title: 'bridge target' }).id;
  return { store, db, issueId };
}

const runsFor = (store: Store, issueId: string) =>
  store.listAgentRunsByIssue(issueId, 50).items;

describe('wake → Run bridge (Q4)', () => {
  it('token boundary: @agentfoo does not wake; whitespace and newlines do (matrix 24)', () => {
    assert.ok(isWakeComment('@agent do it'));
    assert.ok(isWakeComment('\n@agent do it'));
    assert.ok(isWakeComment('@agent'));
    assert.ok(!isWakeComment('@agentfoo do it'));
    assert.ok(!isWakeComment('agent do it'));
    assert.ok(!isWakeComment('plain text'));
  });

  it('qualified @agent comment creates exactly one comment_wake run; replay-safe (matrix 22/23/26)', () => {
    const { store, issueId } = fixture();
    store.addComment(issueId, { author: 'alice', body: '@agent handle the deploy' });
    const runs = runsFor(store, issueId);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.sourceType, 'comment_wake');
    assert.equal(runs[0]!.sourceGeneration, 1);
    assert.equal(runs[0]!.attemptNo, 1);
    assert.equal(runs[0]!.status, 'queued');
    // a non-web/admin login name works (marker model, no whitelist)
    assert.equal(store.getAgentRun(runs[0]!.id)!.idempotencyKey, `comment:${runs[0]!.sourceCommentId}:gen1`);
    // replay (poll/scan recomputation) creates no second run
    const n = store.backfillCommentWakeRuns();
    assert.equal(n.created, 0, 'existing run ⇒ backfill skips');
    assert.equal(runsFor(store, issueId).length, 1);
  });

  it('plain comments and system audit echoes never create runs (matrix 21/25)', () => {
    const { store, issueId } = fixture();
    store.addComment(issueId, { author: 'alice', body: 'plain discussion' });
    store.addComment(issueId, { author: 'sisyphus', body: '@agent from an agent channel', source: 'system' });
    assert.equal(runsFor(store, issueId).length, 0);
  });

  it('re-wake via body edit bumps generation and creates a second run (matrix 27)', () => {
    const { store, issueId } = fixture();
    const c = store.addComment(issueId, { author: 'web', body: '@agent v1 instruction' });
    const first = runsFor(store, issueId)[0]!;
    store.updateComment(c.id, { body: '@agent v2 instruction' }, 'web', 'web');
    const runs = runsFor(store, issueId);
    assert.equal(runs.length, 2);
    const second = runs.find(r => r.id !== first.id)!;
    assert.equal(second.sourceGeneration, 2);
    assert.equal(second.previousRunId, null);
    // first run history untouched
    assert.equal(store.getAgentRun(first.id)!.status, 'queued');
  });

  it('de-wake: body edit to plain cancels still-queued runs (matrix 28)', () => {
    const { store, issueId } = fixture();
    const c = store.addComment(issueId, { author: 'web', body: '@agent do it' });
    assert.equal(runsFor(store, issueId).length, 1);
    store.updateComment(c.id, { body: 'actually never mind' }, 'web', 'web');
    const runs = runsFor(store, issueId);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.status, 'cancelled');
  });

  it('projection: claim → processing, succeed → processed (matrix 34 core)', () => {
    const { store, issueId } = fixture();
    const c = store.addComment(issueId, { author: 'web', body: '@agent project it' });
    const comment = () => store.listComments(issueId).find(x => x.id === c.id)!;
    const claimed = store.claimNextAgentRun('worker-1', 'engine-1');
    assert.ok(claimed);
    assert.equal(comment().status, 'processing', 'starting projects to processing');
    store.transitionRun(claimed!.id, 'running');
    assert.equal(comment().status, 'processing');
    store.transitionRun(claimed!.id, 'succeeded', { resultSummary: 'ok' });
    assert.equal(comment().status, 'processed', 'succeeded projects to processed');
  });

  it('backfill: legacy pending valid creates runs in order; legacy boundary fixed; processed never imported (matrix 29/31)', () => {
    const { store, db, issueId } = fixture();
    // legacy pending valid @agent (older queued_at first)
    db.prepare(
      "INSERT INTO comments (id, issue_id, author, body, created_at, updated_at, queued_at, status, source, is_wake, wake_generation) VALUES ('l1', ?, 'web', '@agent old request', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'pending', 'legacy', 1, 1)",
    ).run(issueId);
    // legacy boundary violation: @agentfoo must be corrected to is_wake=0
    db.prepare(
      "INSERT INTO comments (id, issue_id, author, body, created_at, updated_at, queued_at, status, source, is_wake, wake_generation) VALUES ('l2', ?, 'web', '@agentfoo not a wake', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z', 'pending', 'legacy', 1, 1)",
    ).run(issueId);
    // processed comment: never imported
    db.prepare(
      "INSERT INTO comments (id, issue_id, author, body, created_at, updated_at, queued_at, status, terminal_at, source, is_wake, wake_generation) VALUES ('l3', ?, 'web', '@agent finished long ago', '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z', 'processed', '2026-01-04T00:00:00Z', 'legacy', 1, 1)",
    ).run(issueId);
    const result = store.backfillCommentWakeRuns();
    assert.equal(result.scanned, 2, 'valid candidate + boundary-violation candidate are both scanned');
    assert.equal(result.created, 1);
    assert.equal(result.correctedLegacy, 1);
    const boundary = db.prepare("SELECT is_wake FROM comments WHERE id = 'l2'").get() as { is_wake: number };
    assert.equal(boundary.is_wake, 0, 'legacy token-boundary violation corrected');
    const imported = runsFor(store, issueId).find(r => r.sourceCommentId === 'l1');
    assert.ok(imported, 'valid legacy pending request imported');
    assert.equal(imported!.idempotencyKey, 'comment:l1:gen1');
    // re-run: fully idempotent
    const again = store.backfillCommentWakeRuns();
    assert.equal(again.created, 0);
  });

  it('done-issue wake comments do not create runs (matrix 36 bridge side)', () => {
    const { store, db, issueId } = fixture();
    db.prepare('UPDATE issues SET status = ? WHERE id = ?').run('done', issueId);
    store.addComment(issueId, { author: 'web', body: '@agent too late' });
    // documented reopen contract: a wake comment on a done task reopens it
    // to in_progress AND creates the run (manual createAgentRun still refuses done)
    assert.equal(runsFor(store, issueId).length, 1);
    assert.equal(store.getIssue(issueId)!.status, 'in_progress');
  });
});
