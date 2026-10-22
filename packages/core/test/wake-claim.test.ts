// Wake-delivery CAS claim (v21): per-attempt claim tokens, ABA safety and the
// comment-level updated_at stamp. Runs against the SOURCE barrel with an
// in-memory DatabaseSync, matching store.test.ts.

import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/index.js';
import { MIGRATIONS } from '../src/db.js';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function fixture(): { store: Store; db: DatabaseSync; commentId: string; issueId: string } {
  const db = new DatabaseSync(':memory:');
  const store = new Store('.unused', db);
  store.createProject({ id: 'p1', name: 'P' });
  const issueId = store.createIssue({ projectId: 'p1', title: 'wake target' }).id;
  const commentId = store.addComment(issueId, { author: 'web', body: '@agent 澶勭悊杩欎釜' }).id;
  return { store, db, commentId, issueId };
}

const row = (db: DatabaseSync, id: string): { status: string; claimedBy: string; updatedAt: string; createdAt: string } =>
  db.prepare('SELECT status, claimed_by AS claimedBy, updated_at AS updatedAt, created_at AS createdAt FROM comments WHERE id = ?')
    .get(id) as unknown as { status: string; claimedBy: string; updatedAt: string; createdAt: string };

describe('Store.claimWake', () => {
  it('claims a pending comment, returns a token, and stamps processing + claimed_by', () => {
    const { store, db, commentId } = fixture();
    const token = store.claimWake(commentId, 'watch', 'run-test')!.token;
    assert.ok(token, 'pending comment must yield a token');
    const current = row(db, commentId);
    assert.equal(current.status, 'processing');
    assert.equal(current.claimedBy, token);
  });

  it('returns null when the comment is already processing or processed', () => {
    const { store, db, commentId } = fixture();
    const first = store.claimWake(commentId, 'watch', 'run-test')!.token;
    assert.ok(first);
    assert.equal(store.claimWake(commentId, 'watch', 'run-t'), null, 'processing is not claimable');
    db.prepare("UPDATE comments SET status = 'processed', claimed_by = '' WHERE id = ?").run(commentId);
    assert.equal(store.claimWake(commentId, 'watch', 'run-t'), null, 'processed is not claimable');
  });

  it('rejects a blank claimer', () => {
    const { store, commentId } = fixture();
    assert.throws(() => store.claimWake(commentId, '  ', 'run-t'), /claimer must be non-empty/);
  });
});

describe('Store.releaseWake', () => {
  it('reverts only with the exact claim token', () => {
    const { store, db, commentId } = fixture();
    const token = store.claimWake(commentId, 'watch', 'run-test')!.token;
    assert.ok(token);
    assert.equal(store.releaseWake(commentId, 'not-the-token', 'pending'), false);
    assert.equal(row(db, commentId).status, 'processing');
    assert.equal(store.releaseWake(commentId, token, 'pending'), true);
    assert.equal(row(db, commentId).status, 'pending');
    assert.equal(row(db, commentId).claimedBy, '');
  });

  it('finalizes a headless success to processed', () => {
    const { store, db, commentId } = fixture();
    const token = store.claimWake(commentId, 'watch', 'run-test')!.token;
    assert.ok(token);
    assert.equal(store.releaseWake(commentId, token, 'processed'), true);
    assert.equal(row(db, commentId).status, 'processed');
  });

  it('is ABA-safe: an old token cannot revert a newer claim', () => {
    const { store, db, commentId } = fixture();
    const first = store.claimWake(commentId, 'watch', 'run-test')!.token;
    assert.ok(first);
    // Simulate the row becoming pending again (edit/re-wake) after attempt one.
    db.prepare("UPDATE comments SET status = 'pending', claimed_by = '' WHERE id = ?").run(commentId);
    const second = store.claimWake(commentId, 'watch', 'run-test')!.token;
    assert.ok(second);
    assert.notEqual(first, second, 'each attempt carries its own token');

    assert.equal(store.releaseWake(commentId, first, 'pending'), false, 'stale token must not win');
    const current = row(db, commentId);
    assert.equal(current.status, 'processing');
    assert.equal(current.claimedBy, second, 'the newer claim keeps ownership');

    assert.equal(store.releaseWake(commentId, second, 'processed'), true);
    assert.equal(row(db, commentId).status, 'processed');
  });

  it('is a no-op for an empty token', () => {
    const { store, commentId } = fixture();
    assert.equal(store.releaseWake(commentId, '', 'pending'), false);
  });
});

describe('comments.updated_at (v21)', () => {
  it('starts equal to created_at and moves on status transitions', async () => {
    const { store, db, commentId } = fixture();
    const initial = row(db, commentId);
    assert.equal(initial.updatedAt, initial.createdAt);

    await sleep(5);
    store.updateComment(commentId, { status: 'processing' }, 'watch');
    const afterUpdate = row(db, commentId);
    assert.equal(afterUpdate.status, 'processing');
    assert.ok(Date.parse(afterUpdate.updatedAt) > Date.parse(initial.updatedAt), 'status update must bump updated_at');

    // Back to pending = the user re-queued it; the next claim must win again.
    store.updateComment(commentId, { status: 'pending' }, 'watch');
    await sleep(5);
    const token = store.claimWake(commentId, 'watch', 'run-test')!.token;
    assert.ok(token);
    const afterClaim = row(db, commentId);
    assert.ok(Date.parse(afterClaim.updatedAt) > Date.parse(afterUpdate.updatedAt), 'claim must bump updated_at');

    await sleep(5);
    assert.equal(store.releaseWake(commentId, token, 'processed'), true);
    const afterRelease = row(db, commentId);
    assert.ok(Date.parse(afterRelease.updatedAt) > Date.parse(afterClaim.updatedAt), 'release must bump updated_at');
  });

  it('keeps claimed_by/updated_at out of the public Comment payload (queue state is public)', () => {
    const { store, commentId } = fixture();
    const comment = store.getComment(commentId);
    assert.ok(comment);
    // attempts/lastError/notBefore 是刻意公开的队列状态（面板徽章需要）；
    // claimed_by（认领令牌）与 updated_at（内部时长）仍然不出现在载荷里。
    assert.deepEqual(Object.keys(comment).sort(), [
      'attempts', 'author', 'body', 'createdAt', 'id', 'issueId', 'lastError', 'notBefore', 'status'
    ]);
  });

  it('ships the v21 migration', () => {
    const db = new DatabaseSync(':memory:');
    const store = new Store('.unused', db);
    void store;
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    assert.equal(version, MIGRATIONS.length);
    assert.ok(version >= 21);
    const columns = (db.prepare('PRAGMA table_info(comments)').all() as { name: string }[]).map(c => c.name);
    assert.ok(columns.includes('claimed_by'));
    assert.ok(columns.includes('updated_at'));
  });
});
