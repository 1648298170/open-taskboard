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
      'attempts', 'author', 'body', 'createdAt', 'id', 'issueId', 'lastError', 'notBefore', 'status', 'terminalAt'
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

describe('wake queue: delayed completion & edit gate (v10)', () => {
  it('completeTerminal resolves a manually-gated comment only for the same round', () => {
    const { store, commentId } = fixture();
    const claim = store.claimWake(commentId, 'watch', 'run-test')!;
    assert.equal(store.terminalizeWake(commentId, claim.token, claim.dispatchId, '已送达未确认'), true);
    // 错误轮次（迟到结果）→ no-op，评论保持人工终态
    assert.equal(store.completeTerminalWake(commentId, 'wrong-dispatch'), false);
    assert.equal(store.getComment(commentId)!.status, 'pending');
    // 正确轮次 → processed + 终态清除
    assert.equal(store.completeTerminalWake(commentId, claim.dispatchId), true);
    assert.equal(store.getComment(commentId)!.status, 'processed');
  });

  it('edit gate keeps round identity when a protection lease exists (v10)', () => {
    const { store, commentId } = fixture();
    const claim = store.claimWake(commentId, 'watch', 'run-test')!;
    assert.equal(store.terminalizeWake(commentId, claim.token, claim.dispatchId, '已送达未确认'), true);
    // 种保护租约（sent）
    store.wakeLeaseAcquire({ leaseKey: 'k|ses_1', sessionId: 'ses_1', serverUrl: 'http://oc.test', holderRun: 'run-test', commentId, dispatchId: claim.dispatchId, nowIso: new Date().toISOString(), ttlMs: 60_000 });
    store.wakeLeaseMarkDispatching('k|ses_1', 1, claim.dispatchId, new Date().toISOString());
    store.wakeLeaseMarkSent('k|ses_1', 1, claim.dispatchId, new Date().toISOString(), 60_000);
    // 受保护编辑：仅存正文，轮次身份与终态保留
    store.updateComment(commentId, { body: '@agent 改过的正文' }, 'web');
    assert.equal(store.getComment(commentId)!.body, '@agent 改过的正文');
    const meta = store.queueMeta(commentId)!;
    assert.equal(meta.terminalAt !== null, true, 'terminal must persist under protection');
    assert.equal(meta.dispatchId, claim.dispatchId, 'round identity must persist under protection');
    // 解除保护后编辑 → 完整重置（新轮次）
    const lease = store.wakeLeaseGet('k|ses_1')!;
    store.wakeLeaseConclude(lease.leaseKey, lease.fence, lease.dispatchId!, new Date().toISOString());
    store.updateComment(commentId, { body: '@agent 再次编辑' }, 'web');
    const meta2 = store.queueMeta(commentId)!;
    assert.equal(meta2.terminalAt, null);
    assert.equal(meta2.dispatchId, null);
    assert.equal(meta2.attempts, 0);
    assert.equal(store.getComment(commentId)!.body, '@agent 再次编辑');
  });
});

describe('wake queue center: priority & revision (Q1)', () => {
  function seedThree(store: Store) {
    const project = store.createProject({ id: 'p1', name: 'P', defaultSessionId: 'ses_1' });
    const issueId = store.createIssue({ projectId: project.id, title: 'T' }).id;
    const a = store.addComment(issueId, { author: 'web', body: '@agent A' }).id;
    const b = store.addComment(issueId, { author: 'web', body: '@agent B' }).id;
    const c = store.addComment(issueId, { author: 'web', body: '@agent C' }).id;
    return { a, b, c, issueId };
  }

  it('priority items sort before normal items in the ready queue', () => {
    const { store, issueId } = fixture();
    const a = store.addComment(issueId, { author: 'web', body: '@agent A' }).id;
    const b = store.addComment(issueId, { author: 'web', body: '@agent B' }).id;
    // B 提升为优先
      assert.equal(store.setWakePriority(b, 0, 1), true);
      const batch = store.listQueueBatch(new Date().toISOString());
      assert.equal(batch[0].id, b, 'priority item must sort first');
      assert.ok(batch.some(c => c.id === a), 'normal item must be in the batch');
      assert.ok(batch.length >= 3, 'fixture comment + A + B = 3');
  });

  it('setWakePriority CAS: expected mismatch returns false; same value is idempotent', () => {
    const { store, issueId } = fixture();
    const cid = store.addComment(issueId, { author: 'web', body: '@agent x' }).id;
    // 当前是 0(normal)；expected=1 不匹配 → false
    assert.equal(store.setWakePriority(cid, 1, 1), false, 'expected mismatch must fail');
    // expected=0 目标=1 → 成功
    assert.equal(store.setWakePriority(cid, 0, 1), true);
    // 当前已是 1，重复设置 → 幂等 true
    assert.equal(store.setWakePriority(cid, 0, 1), true, 'idempotent same-value must succeed');
  });

  it('manual re-wake resets priority to normal', () => {
    const { store, issueId } = fixture();
    const cid = store.addComment(issueId, { author: 'web', body: '@agent x' }).id;
    store.setWakePriority(cid, 0, 1);
    assert.equal(store.queueMeta(cid)!.queuePriority, 1);
    // 人工重唤醒（status → pending）→ priority 归 normal
    store.updateComment(cid, { status: 'pending' });
    assert.equal(store.queueMeta(cid)!.queuePriority, 0, 're-wake must reset priority');
    assert.equal(store.queueMeta(cid)!.priorityAt, null);
  });

  it('queueRevision increments on priority change', () => {
    const { store, issueId } = fixture();
    const cid = store.addComment(issueId, { author: 'web', body: '@agent x' }).id;
    const before = store.getQueueRevision();
    store.setWakePriority(cid, 0, 1);
    assert.equal(store.getQueueRevision(), before + 1, 'revision must increment');
  });

  it('claimNextWake returns the highest-priority ready candidate', () => {
    const db = new DatabaseSync(':memory:');
    const store = new Store('.unused', db);
    const project = store.createProject({ id: 'p1', name: 'P', defaultSessionId: 'ses_1' });
    const issueId = store.createIssue({ projectId: project.id, title: 'T' }).id;
    const a = store.addComment(issueId, { author: 'web', body: '@agent A' }).id;
    const b = store.addComment(issueId, { author: 'web', body: '@agent B' }).id;
    store.setWakePriority(b, 0, 1);
    const result = store.claimNextWake('watch', 'run-pri', '@agent');
    assert.ok(result, 'claimNextWake must find a candidate');
    assert.equal(result!.commentId, b, 'priority item must be claimed first');
    // 第二次 claim → 次高顺序（normal A）
    const r2 = store.claimNextWake('watch', 'run-pri', '@agent');
    assert.ok(r2);
    assert.equal(r2!.commentId, a, 'next claim must get the normal item');
    // 第三次 → 无候选
    assert.equal(store.claimNextWake('watch', 'run-pri', '@agent'), null);
  });
});
