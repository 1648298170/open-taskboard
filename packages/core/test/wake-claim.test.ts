// Wake-delivery CAS claim (v21): per-attempt claim tokens, ABA safety and the
// comment-level updated_at stamp. Runs against the SOURCE barrel with an
// in-memory DatabaseSync, matching store.test.ts.

import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Store, ConflictError, wakeViewState } from '../src/index.js';
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

  it('queueSnapshot works with and without projectId (regression: unused named parameter 500)', () => {
    const { store, issueId } = fixture();
    store.addComment(issueId, { author: 'web', body: '@agent A' }).id;
    // 无 projectId：SQL 不含 @projectId，参数对象也不得携带（node:sqlite 对未使用命名参数抛 ERR_INVALID_STATE）
    const snap = store.wakeQueueSnapshot(new Date().toISOString());
    assert.ok(snap.counts.pending >= 1, 'pending count must include the wake comment');
    assert.ok(snap.items.length >= 1, 'items must list the wake comment');
    // 带 projectId：同一查询走 @projectId 过滤路径
    const filtered = store.wakeQueueSnapshot(new Date().toISOString(), { projectId: 'p1' });
    assert.ok(filtered.counts.pending >= 1, 'project-filtered snapshot must also work');
  });

  it('human plain comments enter the queue without the @agent prefix (口径已确认)', () => {
    const { store, commentId, issueId } = fixture();
    // 先移除夹具自带的前缀评论，隔离验证普通评论的入队与领取
    store.deleteComment(commentId, 'web');
    const plain = store.addComment(issueId, { author: 'web', body: '普通评论也要入队' }).id;
    const batch = store.listQueueBatch(new Date().toISOString());
    assert.ok(batch.some(c => c.id === plain), 'human plain comment must be queued');
    const claimed = store.claimNextWake('watch', 'run-plain', '@agent');
    assert.ok(claimed && claimed.commentId === plain, 'human plain comment must be claimable');
  });

  it('system audit comments (状态变更记录) never enter the wake queue (防唤醒风暴)', () => {
    const { store, commentId, issueId } = fixture();
    // 用户点 done 产生的系统审计评论：author=web（人类白名单内）但内容是系统回声
    const audit = store.addComment(issueId, { author: 'web', body: '状态变更记录：in_review → done\nTaskboard 网页人工操作；操作者未提供额外说明。' }).id;
    store.deleteComment(commentId, 'web'); // 移除夹具自带的前缀评论，隔离验证审计评论被排除
    assert.equal(store.listQueueBatch(new Date().toISOString()).some(c => c.id === audit), false, 'audit comment must not be swept');
    assert.equal(store.claimNextWake('watch', 'run-audit', '@agent'), null, 'audit comment must not be claimable');
    const snap = store.wakeQueueSnapshot(new Date().toISOString());
    assert.equal(snap.items.some(i => i.commentId === audit), false, 'audit comment must not appear in the queue view');
  });

  it('waitReason uses per-item session evidence, not global processing counts (P2-2)', () => {
    const db = new DatabaseSync(':memory:');
    const store = new Store('.unused', db);
    store.createProject({ id: 'p1', name: 'P', defaultSessionId: 'ses_1' });
    store.createProject({ id: 'p2', name: 'Q', defaultSessionId: 'ses_2' });
    const i1 = store.createIssue({ projectId: 'p1', title: 'T1' }).id;
    const i2 = store.createIssue({ projectId: 'p2', title: 'T2' }).id;
    const a = store.addComment(i1, { author: 'web', body: '@agent 排队者' }).id;
    const b = store.addComment(i2, { author: 'web', body: '@agent 全局执行中' }).id;
    // 全局存在 processing（p2 的 B），但 A 的 Session 无任何租约证据 → 不得虚报
    assert.ok(store.claimWake(b, 'watch', 'run-b'));
    const snap1 = store.wakeQueueSnapshot(new Date().toISOString());
    assert.equal(snap1.items.find(x => x.commentId === a)!.waitReason, null, 'global processing must not imply session-protected');
    // A 所属 Session 出现活动租约 → 才允许 session-protected
    store.wakeLeaseAcquire({
      leaseKey: 'http://oc.test|ses_1', sessionId: 'ses_1', serverUrl: 'http://oc.test',
      holderRun: 'run-x', commentId: 'cx', dispatchId: 'dx', nowIso: new Date().toISOString(), ttlMs: 60_000,
    });
    const snap2 = store.wakeQueueSnapshot(new Date().toISOString());
    assert.equal(snap2.items.find(x => x.commentId === a)!.waitReason, 'session-protected', 'same-session active lease must be reported');
  });
});

describe('Store.wakeLeaseHasActiveForSession (§5 migration guard)', () => {
  const acquire = (store: Store, leaseKey: string, sessionId: string, ttlMs = 60_000): void => {
    const ok = store.wakeLeaseAcquire({
      leaseKey, sessionId, serverUrl: 'http://oc.test', holderRun: 'run-x',
      commentId: 'c-x', dispatchId: 'd-x', nowIso: new Date().toISOString(), ttlMs,
    });
    assert.ok(ok, `acquire ${leaseKey} must succeed`);
  };

  it('counts only active leases under legacy URL-shaped keys, excluding the new namespace key', () => {
    const db = new DatabaseSync(':memory:');
    const store = new Store('.unused', db);
    store.createProject({ id: 'p1', name: 'P' });
    const now = new Date().toISOString();
    // 活动的旧 URL 命名空间租约 → 计入
    acquire(store, 'http://oc.test|ses_1', 'ses_1');
    assert.equal(store.wakeLeaseHasActiveForSession('ses_1', 'svc-1|ses_1', now), true, 'active legacy lease must block');
    // released → 不计入
    const legacy = store.wakeLeaseGet('http://oc.test|ses_1')!;
    store.wakeLeaseReleaseHeld(legacy.leaseKey, legacy.fence, 'run-x', 'c-x', 'd-x');
    assert.equal(store.wakeLeaseGet(legacy.leaseKey)?.state, 'released');
    assert.equal(store.wakeLeaseHasActiveForSession('ses_1', 'svc-1|ses_1', now), false, 'released legacy lease must not block');
    // 过期 held → 不计入
    acquire(store, 'http://oc.test|ses_2', 'ses_2', -1_000);
    assert.equal(store.wakeLeaseHasActiveForSession('ses_2', 'svc-1|ses_2', now), false, 'expired held lease must not block');
    // 非旧命名空间（无 ://）的活动租约 → 不计入（不同 serviceId 不互查）
    acquire(store, 'svc-a|ses_3', 'ses_3');
    assert.equal(store.wakeLeaseHasActiveForSession('ses_3', 'svc-b|ses_3', now), false, 'another explicit service id must not block');
  });
});

describe('wakeViewState derivation (§7)', () => {
  const view = (status: string, terminalAt: string | null, runEvidence: string | null, leaseState: string | null): string =>
    wakeViewState({ status, terminalAt, runEvidence, leaseState });

  it('derives the user-visible state from persisted evidence only', () => {
    assert.equal(view('processed', null, null, null), 'done');
    assert.equal(view('pending', '2026-01-01T00:00:00Z', null, null), 'manual');
    assert.equal(view('pending', null, 'running', null), 'queued', 'evidence without a claim is stale and ignored');
    assert.equal(view('pending', null, null, null), 'queued');
    assert.equal(view('processing', null, null, null), 'verifying', 'processing without protection = recovery window');
    assert.equal(view('processing', null, null, 'held'), 'preparing');
    assert.equal(view('processing', null, null, 'dispatching'), 'preparing');
    // HTTP 200 / sent 租约本身绝不等于 running
    assert.equal(view('processing', null, null, 'sent'), 'sent-waiting');
    assert.equal(view('processing', null, 'running', 'sent'), 'running');
    assert.equal(view('processing', null, 'running', 'unverified_sent'), 'running');
    assert.equal(view('processing', null, null, 'unverified_sent'), 'verifying');
    assert.equal(view('processing', null, 'tui-waiting', null), 'tui-waiting');
  });

  it('setRunEvidence is dispatch-bound and cleared by the next claim', () => {
    const { store, commentId } = fixture();
    const claim = store.claimWake(commentId, 'watch', 'run-ev')!;
    assert.ok(claim);
    assert.equal(store.setRunEvidence(commentId, claim.dispatchId, 'running'), true);
    assert.equal(store.queueMeta(commentId)!.runEvidence, 'running');
    assert.equal(store.setRunEvidence(commentId, 'other-dispatch', 'running'), false, 'late evidence cannot cross rounds');
    store.releaseWake(commentId, claim.token, 'pending');
    const claim2 = store.claimWake(commentId, 'watch', 'run-ev2')!;
    assert.ok(claim2);
    assert.equal(store.queueMeta(commentId)!.runEvidence, null, 'a new round starts without evidence');
  });
});

describe('protected comment deletion & reclassification (§6)', () => {
  function round(store: Store, commentId: string): { token: string; dispatchId: string } {
    const claim = store.claimWake(commentId, 'watch', 'run-del')!;
    assert.ok(claim, 'round claim must succeed');
    assert.ok(store.wakeLeaseAcquire({
      leaseKey: 'http://oc.test|ses_del', sessionId: 'ses_del', serverUrl: 'http://oc.test',
      holderRun: 'run-del', commentId, dispatchId: claim.dispatchId,
      nowIso: new Date().toISOString(), ttlMs: 60_000,
    }), 'lease acquire must succeed');
    assert.ok(store.wakeLeaseMarkDispatching('http://oc.test|ses_del', 1, claim.dispatchId, new Date().toISOString()));
    assert.ok(store.wakeLeaseMarkSent('http://oc.test|ses_del', 1, claim.dispatchId, new Date().toISOString(), 60_000));
    return claim;
  }

  const expectProtected = (fn: () => unknown): void => {
    assert.throws(fn, (err: unknown) => {
      const e = err as ConflictError & { code?: string };
      return e instanceof ConflictError && e.code === 'COMMENT_DISPATCH_PROTECTED';
    }, 'deletion must be rejected with COMMENT_DISPATCH_PROTECTED');
  };

  it('deletes a plain pending comment', () => {
    const { store, issueId } = fixture();
    const plain = store.addComment(issueId, { author: 'web', body: '普通评论' }).id;
    store.deleteComment(plain, 'web');
    assert.equal(store.getComment(plain), null);
  });

  it('rejects deleting a claimed (processing) comment', () => {
    const { store, commentId } = fixture();
    assert.ok(store.claimWake(commentId, 'watch', 'run-x'));
    expectProtected(() => store.deleteComment(commentId, 'web'));
  });

  it('rejects deleting a comment with an active sent lease, even terminalized', () => {
    const { store, commentId } = fixture();
    const claim = round(store, commentId);
    expectProtected(() => store.deleteComment(commentId, 'web'));
    // 转人工终态后保护租约仍未解除 → 依旧拒绝
    assert.ok(store.terminalizeWake(commentId, claim.token, claim.dispatchId, '人工门禁'));
    expectProtected(() => store.deleteComment(commentId, 'web'));
  });

  it('allows deletion once the round resolves and the lease concludes', () => {
    const { store, commentId } = fixture();
    const claim = round(store, commentId);
    // 人工终态后保护租约仍未解除 → 依旧拒绝
    assert.ok(store.terminalizeWake(commentId, claim.token, claim.dispatchId, '人工门禁'));
    expectProtected(() => store.deleteComment(commentId, 'web'));
    // 租约 conclude（轮次收尾）→ 保护解除 → 可删
    assert.ok(store.wakeLeaseConclude('http://oc.test|ses_del', 1, claim.dispatchId, new Date().toISOString()));
    store.deleteComment(commentId, 'web');
    assert.equal(store.getComment(commentId), null);
  });

  it('still rejects editing the body of a processing comment (regression)', () => {
    const { store, commentId } = fixture();
    assert.ok(store.claimWake(commentId, 'watch', 'run-x'));
    assert.throws(() => store.updateComment(commentId, { body: '@agent 改' }, 'web'), /only pending comments can be edited/);
  });

  it('blocks manual re-wake while protected, but allows the processed confirmation (§6/§3)', () => {
    const { store, commentId } = fixture();
    round(store, commentId);
    // status→pending 会清 dispatch_id，把活动租约变成无人收尾的孤儿 → 拒绝
    assert.throws(() => store.updateComment(commentId, { status: 'pending' }, 'web'), (err: unknown) => {
      const e = err as ConflictError & { code?: string };
      return e instanceof ConflictError && e.code === 'COMMENT_DISPATCH_PROTECTED';
    });
    // agent 确认完成是可靠收尾 → 放行
    store.updateComment(commentId, { status: 'processed' }, 'web');
    assert.equal(store.getComment(commentId)!.status, 'processed');
  });

  it('D2 cancel: pending comment lands on the terminal gate and leaves the queue', () => {
    const { store, commentId } = fixture();
    assert.equal(store.cancelWake(commentId, '用户取消'), true);
    const meta = store.queueMeta(commentId)!;
    assert.equal(store.getComment(commentId)!.status, 'pending');
    assert.ok(meta.terminalAt, 'cancel must set the manual gate');
    assert.equal(meta.attempts, 0);
    // 再取消 → 幂等 false（已终态）
    assert.equal(store.cancelWake(commentId, '再取消'), false);
  });

  it('D2 cancel: processing round concludes its lease and the session stays dispatchable', () => {
    const { store, commentId } = fixture();
    round(store, commentId);
    assert.equal(store.cancelWake(commentId, '排队中心取消执行中任务'), true);
    const meta = store.queueMeta(commentId)!;
    assert.ok(meta.terminalAt, 'cancelled processing round lands on the manual gate');
    assert.equal(
      store.wakeLeaseFindByComment(commentId, meta.dispatchId!)!.state,
      'released',
      'cancel must conclude the round lease',
    );
  });

  it('reclassifies wake → normal on edit and clears priority metadata', () => {
    const { store, commentId } = fixture();
    assert.equal(store.setWakePriority(commentId, 0, 1), true);
    store.updateComment(commentId, { body: '不再是唤醒指令' }, 'web');
    const meta = store.queueMeta(commentId)!;
    assert.equal(meta.queuePriority, 0, 'priority must clear on wake→plain edit');
    assert.equal(meta.priorityAt, null);
    assert.equal(meta.notBefore, null);
    // 口径更新：资格按作者判定——普通人类评论仍留在队列（普通优先级），仅清除优先级元数据
    const snap = store.wakeQueueSnapshot(new Date().toISOString());
    const row = snap.items.find(i => i.commentId === commentId)!;
    assert.ok(row, 'human plain comment stays in the queue view');
    assert.equal(row.queuePriority, 0);
  });

  it('keeps priority when a wake comment is edited to another wake body', () => {
    const { store, commentId } = fixture();
    assert.equal(store.setWakePriority(commentId, 0, 1), true);
    store.updateComment(commentId, { body: '@agent 改写后的指令' }, 'web');
    assert.equal(store.queueMeta(commentId)!.queuePriority, 1, 'still a wake comment: priority must survive');
  });

  it('a normal comment edited to wake enters the queue with normal priority', () => {
    const { store, issueId } = fixture();
    const plain = store.addComment(issueId, { author: 'web', body: '普通起点' }).id;
    store.updateComment(plain, { body: '@agent 现在是唤醒' }, 'web');
    const batch = store.listQueueBatch(new Date().toISOString());
    assert.ok(batch.some(c => c.id === plain), 'the reclassified comment must be claimable');
    assert.equal(store.queueMeta(plain)!.queuePriority, 0, 'a new wake round enters as normal');
  });
});

describe('claimNextWake strategy filters (§4+§8)', () => {
  it('never claims a wake on an archived issue — claim and list stay consistent with the snapshot', () => {
    const db = new DatabaseSync(':memory:');
    const store = new Store('.unused', db);
    store.createProject({ id: 'p1', name: 'P', defaultSessionId: 'ses_1' });
    const issueId = store.createIssue({ projectId: 'p1', title: 'T' }).id;
    store.addComment(issueId, { author: 'web', body: '@agent 归档前' }).id;
    store.archiveIssue(issueId, 'web');
    assert.equal(store.claimNextWake('watch', 'run-arch', '@agent'), null, 'archived issues must not be claimed');
    assert.equal(store.listQueueBatch(new Date().toISOString()).length, 0, 'archived issues must not be listed');
    const snap = store.wakeQueueSnapshot(new Date().toISOString());
    assert.equal(snap.counts.pending, 0, 'snapshot agrees: archived excluded everywhere');
  });

  it('skips not-yet-due candidates and honors executor scope (ignoreAuthors/projectFilter)', () => {
    const db = new DatabaseSync(':memory:');
    const store = new Store('.unused', db);
    store.createProject({ id: 'p1', name: 'P', defaultSessionId: 'ses_1' });
    store.createProject({ id: 'p2', name: 'Q', defaultSessionId: 'ses_2' });
    const i1 = store.createIssue({ projectId: 'p1', title: 'T1' }).id;
    const i2 = store.createIssue({ projectId: 'p2', title: 'T2' }).id;
    const future = new Date(Date.now() + 60_000).toISOString();
    const a = store.addComment(i1, { author: 'web', body: '@agent 未到期' }).id;
    db.prepare('UPDATE comments SET not_before = ? WHERE id = ?').run(future, a);
    assert.equal(store.claimNextWake('watch', 'run-due', '@agent'), null, 'not_before must gate atomic claim');
    db.prepare('UPDATE comments SET not_before = NULL WHERE id = ?').run(a);
    const b = store.addComment(i1, { author: 'watch', body: '@agent 自唤醒' }).id;
    const c = store.addComment(i2, { author: 'web', body: '@agent p2 候选' }).id;
    // 执行器范围：ignoreAuthors 过滤自身作者（同毫秒 tiebreak 是随机 id，
    // 不依赖具体领到 a 还是 c——只断言被忽略者不领、候选可领）
    const c1 = store.claimNextWake('watch', 'run-scope', '@agent', { ignoreAuthors: ['watch'] });
    assert.ok(c1, 'a non-ignored candidate must still be found');
    assert.notEqual(c1!.commentId, b, 'the ignored author must be skipped');
    assert.equal(
      (db.prepare('SELECT status FROM comments WHERE id = ?').get(b) as { status: string }).status,
      'pending',
      'the ignored-author candidate must stay pending',
    );
    store.releaseWake(c1!.commentId, c1!.token, 'pending');
    // projectFilter 约束领取范围：p2 视角只能领到 c
    const c2 = store.claimNextWake('watch', 'run-scope2', '@agent', { projectFilter: 'p2' });
    assert.ok(c2, 'the p2 candidate must be claimed under the project scope');
    assert.equal(c2!.commentId, c, 'the p1 candidates must not leak into the p2 scope');
  });
});
