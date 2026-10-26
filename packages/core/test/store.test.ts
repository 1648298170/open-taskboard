// Regression net for the Store domain layer (packages/core/src/store.ts).
//
// Runs against the SOURCE barrel ('../src/index.js') via tsx, so a broken
// src fails here loudly — dist is never exercised. Every test builds its
// own fixture via fresh(): a Store over an in-memory sqlite db (the
// DatabaseSync DI seam) plus a private event collector — no shared mutable
// state, no reliance on hook scoping, fully isolated per test.
//
// Note: test/ is intentionally OUTSIDE tsconfig include ["src"] — this file
// is not part of build/typecheck. The two `as Status`/`as Priority` casts
// below deliberately simulate untrusted input crossing the API boundary
// (what HTTP/CLI/MCP layers hand the Store in production).

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Store, NotFoundError, ConflictError, ValidationError, PermissionError, isWakeComment } from '../src/index.js';
import { restUpdateIssueSchema } from '../src/schemas.js';
import { MIGRATIONS } from '../src/db.js';
import type { StoreEvent, Status, Priority } from '../src/index.js';

// --- helpers --------------------------------------------------------------

// Asserts that fn throws exactly Ctor with exactly the expected message
// (string = strict equality, RegExp = match). Keeps error-class assertions
// instanceof-based per the package barrel exports.
function throwsWith(
  fn: () => unknown,
  Ctor: new (message: string) => Error,
  expected: string | RegExp
): void {
  let caught: unknown;
  try { fn(); } catch (err) { caught = err; }
  if (caught === undefined) assert.fail(`expected ${Ctor.name} but nothing was thrown`);
  assert.ok(caught instanceof Ctor, `expected ${Ctor.name}, got: ${String(caught)}`);
  if (typeof expected === 'string') assert.equal(caught.message, expected);
  else assert.match(caught.message, expected);
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// Per-test fixture: fresh Store + fresh event collector.
function fresh(): { store: Store; events: StoreEvent[] } {
  const store = new Store('.unused', new DatabaseSync(':memory:'));
  const events: StoreEvent[] = [];
  store.subscribe(e => events.push(e));
  return { store, events };
}

const idsFor = (events: StoreEvent[], type: string): unknown[] =>
  events.filter(e => e.type === type).map(e => e.payload.id);

// Topology used by the parent-validation suites:
//   p1: A (top) → B (child of A), C (top)
//   p2: D (top)
function seedTwoProjects(store: Store): { A: string; B: string; C: string; D: string } {
  store.createProject({ id: 'p1', name: 'Project One' });
  store.createProject({ id: 'p2', name: 'Project Two' });
  const A = store.createIssue({ projectId: 'p1', title: 'A' }).id;
  const B = store.createIssue({ projectId: 'p1', parentId: A, title: 'B' }).id;
  const C = store.createIssue({ projectId: 'p1', title: 'C' }).id;
  const D = store.createIssue({ projectId: 'p2', title: 'D' }).id;
  return { A, B, C, D };
}

// --- (a) optimistic locking -------------------------------------------------

describe('Store.updateIssue optimistic lock', () => {
  function seed1(store: Store): string {
    store.createProject({ id: 'p1', name: 'P' });
    return store.createIssue({ projectId: 'p1', title: 'lock' }).id;
  }

  it('throws ConflictError matching /version conflict/ on wrong expectedVersion', () => {
    const { store } = fresh();
    const id = seed1(store);
    throwsWith(() => store.updateIssue(id, { title: 'nope' }, 999), ConflictError, /version conflict/);
  });

  it('succeeds with the correct expectedVersion and bumps version, emitting issue.updated', () => {
    const { store, events } = fresh();
    const id = seed1(store);
    const updated = store.updateIssue(id, { title: 'renamed' }, 1);
    assert.equal(updated.version, 2);
    assert.equal(updated.title, 'renamed');
    assert.deepEqual(idsFor(events, 'issue.updated'), [id]);
  });

  it('succeeds with undefined expectedVersion (lock-free)', () => {
    const { store } = fresh();
    const id = seed1(store);
    const updated = store.updateIssue(id, { title: 'free' });
    assert.equal(updated.version, 2);
  });

  it('rejects the stale version after a bump', () => {
    const { store } = fresh();
    const id = seed1(store);
    store.updateIssue(id, { title: 'first' }, 1); // now v2
    throwsWith(() => store.updateIssue(id, { title: 'stale' }, 1), ConflictError, /version conflict/);
  });
});

// --- atomic status transition audit -------------------------------------------

describe('Store.updateIssue status audit', () => {
  function seed(store: Store): string {
    store.createProject({ id: 'p1', name: 'P' });
    return store.createIssue({ projectId: 'p1', title: 'audit target', status: 'todo' }).id;
  }

  it('rejects a named agent transition without a note before mutating anything', () => {
    const { store } = fresh();
    const id = seed(store);
    throwsWith(
      () => store.updateIssue(id, { status: 'in_review' }, 1, 'codex'),
      ValidationError,
      /statusNote/
    );
    assert.equal(store.getIssue(id)!.status, 'todo');
    assert.equal(store.getIssue(id)!.version, 1);
    assert.equal(store.listComments(id).length, 0);
  });

  it('writes status + audit comment + search index in one successful operation', () => {
    const { store, events } = fresh();
    const id = seed(store);
    const note = '原因：功能完成。验证证据：测试通过。未覆盖：浏览器目验。';
    const updated = store.updateIssue(id, { status: 'in_review' }, 1, 'codex', note);
    const comments = store.listComments(id);
    assert.equal(updated.status, 'in_review');
    assert.equal(updated.version, 2);
    assert.equal(comments.length, 1);
    assert.equal(comments[0]!.author, 'codex');
    assert.match(comments[0]!.body, /todo → in_review/);
    assert.ok(comments[0]!.body.includes(note));
    assert.deepEqual(store.search('浏览器目验').map(hit => hit.id), [id]);
    assert.deepEqual(idsFor(events, 'issue.updated'), [id]);
    assert.deepEqual(idsFor(events, 'comment.created'), [comments[0]!.id]);
  });

  it('does not leave a comment when optimistic locking fails', () => {
    const { store } = fresh();
    const id = seed(store);
    throwsWith(
      () => store.updateIssue(id, { status: 'in_review' }, 99, 'codex', '原因：x。验证：y。未覆盖：z。'),
      ConflictError,
      /version conflict/
    );
    assert.equal(store.getIssue(id)!.status, 'todo');
    assert.equal(store.listComments(id).length, 0);
  });
});

// --- (b) empty patch ---------------------------------------------------------

describe('Store.updateIssue empty patch', () => {
  it('returns the current issue, leaves version unchanged, emits no issue.updated', () => {
    const { store, events } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const id = store.createIssue({ projectId: 'p1', title: 'stable', status: 'todo' }).id;

    const before = store.getIssue(id);
    assert.ok(before);
    const result = store.updateIssue(id, {}, 1);

    assert.equal(result.version, 1);
    assert.deepEqual(result, before);
    assert.equal(events.filter(e => e.type === 'issue.updated').length, 0);
  });
});

// --- (c) P0 parent validation on update (the regression net) -----------------

describe('Store.updateIssue parent validation (P0)', () => {
  it('rejects an issue becoming its own parent', () => {
    const { store } = fresh();
    const { C } = seedTwoProjects(store);
    throwsWith(
      () => store.updateIssue(C, { parentId: C }),
      ValidationError,
      'an issue cannot be its own parent'
    );
  });

  it('rejects a nonexistent parent', () => {
    const { store } = fresh();
    const { C } = seedTwoProjects(store);
    throwsWith(
      () => store.updateIssue(C, { parentId: 'zzz' }),
      NotFoundError,
      'parent issue not found: zzz'
    );
  });

  it('rejects nesting under a child issue (would create a grandchild)', () => {
    const { store } = fresh();
    const { B, C } = seedTwoProjects(store);
    throwsWith(
      () => store.updateIssue(C, { parentId: B }),
      ValidationError,
      'only one level of nesting is supported (parent must be a top-level issue)'
    );
  });

  it('rejects a parent from another project', () => {
    const { store } = fresh();
    const { C, D } = seedTwoProjects(store);
    throwsWith(
      () => store.updateIssue(C, { parentId: D }),
      ValidationError,
      'parent issue belongs to a different project'
    );
  });

  it('unlinks the parent when parentId is null', () => {
    const { store } = fresh();
    const { B } = seedTwoProjects(store);
    const updated = store.updateIssue(B, { parentId: null }, 1);
    assert.equal(updated.parentId, null);
    assert.equal(updated.version, 2);
  });

  it('accepts a valid top-level same-project parent', () => {
    const { store, events } = fresh();
    const { A, C } = seedTwoProjects(store);
    const updated = store.updateIssue(C, { parentId: A }, 1);
    assert.equal(updated.parentId, A);
    assert.equal(updated.version, 2);
    assert.deepEqual(idsFor(events, 'issue.updated'), [C]);
  });
});

// --- (d) createIssue validation ----------------------------------------------

describe('Store.createIssue validation', () => {
  it('rejects a cross-project parent', () => {
    const { store } = fresh();
    const { D } = seedTwoProjects(store);
    throwsWith(
      () => store.createIssue({ projectId: 'p1', parentId: D, title: 'x' }),
      ValidationError,
      'parent issue belongs to a different project'
    );
  });

  it('rejects a parent that already has a parent', () => {
    const { store } = fresh();
    const { B } = seedTwoProjects(store);
    throwsWith(
      () => store.createIssue({ projectId: 'p1', parentId: B, title: 'x' }),
      ValidationError,
      'only one level of nesting is supported (parent must be a top-level issue)'
    );
  });

  it('rejects a nonexistent parent', () => {
    const { store } = fresh();
    seedTwoProjects(store);
    throwsWith(
      () => store.createIssue({ projectId: 'p1', parentId: 'zzz', title: 'x' }),
      NotFoundError,
      'parent issue not found: zzz'
    );
  });

  it('rejects an invalid status', () => {
    const { store } = fresh();
    seedTwoProjects(store);
    const bogusStatus = 'bogus' as Status; // deliberate: simulates untrusted input
    throwsWith(
      () => store.createIssue({ projectId: 'p1', title: 'x', status: bogusStatus }),
      ValidationError,
      'invalid status: bogus'
    );
  });

  it('rejects an invalid priority', () => {
    const { store } = fresh();
    seedTwoProjects(store);
    const bogusPriority = 'bogus' as Priority; // deliberate: simulates untrusted input
    throwsWith(
      () => store.createIssue({ projectId: 'p1', title: 'x', priority: bogusPriority }),
      ValidationError,
      'invalid priority: bogus'
    );
  });

  it('rejects a nonexistent project', () => {
    const { store } = fresh();
    throwsWith(
      () => store.createIssue({ projectId: 'nope', title: 'x' }),
      NotFoundError,
      'project not found: nope'
    );
  });

  it('creates with defaults: status todo, priority medium, version 1', () => {
    const { store, events } = fresh();
    seedTwoProjects(store); // itself emits 4 issue.created events (A/B/C/D)
    const issue = store.createIssue({ projectId: 'p1', title: 'fresh' });
    assert.equal(issue.status, 'todo');
    assert.equal(issue.priority, 'medium');
    assert.equal(issue.version, 1);
    assert.equal(issue.parentId, null);
    assert.deepEqual(idsFor(events, 'issue.created').slice(-1), [issue.id]);
  });
});

// --- (e) deleteIssue cascade --------------------------------------------------

describe('Store.deleteIssue cascade', () => {
  it('deletes children and comments, emitting issue.deleted children-first', () => {
    const { store, events } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const parent = store.createIssue({ projectId: 'p1', title: 'parent' }).id;
    const child = store.createIssue({ projectId: 'p1', parentId: parent, title: 'child' }).id;
    store.addComment(parent, { body: 'on parent' });
    store.addComment(child, { body: 'on child' });

    store.deleteIssue(parent);

    // node:sqlite's get() yields undefined for a missing row; the Store's
    // "not found" contract is falsy (typed as Issue | null in the API).
    assert.equal(store.getIssue(parent), undefined);
    assert.equal(store.getIssue(child), undefined);
    assert.equal(store.listIssues('p1').length, 0);
    assert.equal(store.listComments(parent).length, 0);
    assert.equal(store.listComments(child).length, 0);
    assert.deepEqual(idsFor(events, 'issue.deleted'), [child, parent]); // children-first order
  });
});

// --- (f) deleteProject ---------------------------------------------------------

describe('Store.deleteProject', () => {
  it('empties projects, issues, and comments; emits project.deleted', () => {
    const { store, events } = fresh();
    store.createProject({ id: 'px', name: 'Doomed' });
    const i1 = store.createIssue({ projectId: 'px', title: 'one' }).id;
    const i2 = store.createIssue({ projectId: 'px', title: 'two' }).id;
    store.addComment(i1, { body: 'c1' });
    store.addComment(i2, { body: 'c2' });

    store.deleteProject('px');

    assert.equal(store.getProject('px'), undefined); // node:sqlite get(): undefined when absent
    assert.equal(store.listIssues('px').length, 0);
    assert.equal(store.listComments(i1).length, 0);
    assert.equal(store.listComments(i2).length, 0);
    assert.deepEqual(idsFor(events, 'project.deleted'), ['px']);
  });

  it('throws NotFoundError for a nonexistent project', () => {
    const { store } = fresh();
    throwsWith(() => store.deleteProject('ghost'), NotFoundError, 'project not found: ghost');
  });
});

// --- (g) addComment -------------------------------------------------------------

describe('Store.addComment', () => {
  it('bumps issue updatedAt but not version; returns comment; emits comment.created', async () => {
    const { store, events } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const id = store.createIssue({ projectId: 'p1', title: 'discussed' }).id;
    const before = store.getIssue(id);
    assert.ok(before);

    await sleep(5); // ensure the updatedAt timestamp differs deterministically
    const comment = store.addComment(id, { author: 'alice', body: 'looks good' });
    const after = store.getIssue(id);
    assert.ok(after);

    assert.equal(after.version, before.version); // version NOT bumped
    assert.ok(new Date(after.updatedAt).getTime() > new Date(before.updatedAt).getTime());
    assert.equal(comment.issueId, id);
    assert.equal(comment.author, 'alice');
    assert.equal(comment.body, 'looks good');
    assert.ok(comment.id.length > 0);
    assert.deepEqual(idsFor(events, 'comment.created'), [comment.id]);
  });

  it('throws NotFoundError for a nonexistent issue', () => {
    const { store } = fresh();
    throwsWith(() => store.addComment('nope', { body: 'x' }), NotFoundError, 'issue not found: nope');
  });
});

// --- (g2) updateComment — wake lifecycle state machine ----------------------------

describe('Store.updateComment', () => {
  const withComment = () => {
    const f = fresh();
    f.store.createProject({ id: 'p1', name: 'P' });
    const issueId = f.store.createIssue({ projectId: 'p1', title: 'task' }).id;
    const comment = f.store.addComment(issueId, { author: 'web', body: 'do the thing' });
    return { ...f, issueId, commentId: comment.id };
  };

  it('edits the body while pending; FTS sees the new text; emits comment.updated', () => {
    const t = withComment();
    t.store.updateComment(t.commentId, { body: 'actually do it right' }, 'web');
    assert.equal(t.store.listComments(t.issueId)[0].body, 'actually do it right');
    assert.deepEqual(idsFor(t.events, 'comment.updated'), [t.commentId]);
    assert.deepEqual(t.store.search('actually do it right').map(h => h.id), [t.issueId]);
  });

  it('refuses body edits once the wake watcher took the comment (processing)', () => {
    const t = withComment();
    t.store.updateComment(t.commentId, { status: 'processing' }, 'watch');
    throwsWith(
      () => t.store.updateComment(t.commentId, { body: 'sneaky edit' }, 'alice'),
      ValidationError, /pending comments can be edited/
    );
  });

  it('lets only the authenticated author edit a username-attributed comment', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const issueId = store.createIssue({ projectId: 'p1', title: 't' }).id;
    const comment = store.addComment(issueId, { author: 'jerry', body: 'my note' });

    throwsWith(
      () => store.updateComment(comment.id, { body: 'forged edit' }, 'jerry', 'someone-else'),
      PermissionError,
      /created by/
    );
    store.updateComment(comment.id, { body: 'updated by jerry' }, 'jerry', 'jerry');
    assert.equal(store.listComments(issueId)[0].body, 'updated by jerry');
  });

  it('walks pending → processing → processed, resetting processed back to pending', () => {
    const t = withComment();
    t.store.updateComment(t.commentId, { status: 'processing' }, 'watch');
    t.store.updateComment(t.commentId, { status: 'processed' }, 'watch');
    assert.equal(t.store.listComments(t.issueId)[0].status, 'processed');
    t.store.updateComment(t.commentId, { status: 'pending' }, 'alice'); // re-wake
    assert.equal(t.store.listComments(t.issueId)[0].status, 'pending');
    assert.deepEqual(idsFor(t.events, 'comment.updated'), [t.commentId, t.commentId, t.commentId]);
  });

  it('re-queues a wake on an edited comment: a re-reviewed task settles back to in_progress too', () => {
    const t = withComment();
    // The user turns the SAME comment into a wake instruction (edit path),
    // then handles and re-queues it instead of writing a new comment.
    t.store.updateComment(t.commentId, { body: '@agent do the thing' }, 'web');
    t.store.updateIssue(t.issueId, { status: 'in_review' });
    t.store.updateComment(t.commentId, { status: 'processed' }, 'watch');
    t.store.updateComment(t.commentId, { status: 'pending' }, 'web');
    assert.equal(t.store.getIssue(t.issueId).status, 'in_progress');
    const acts = t.store.listActivities(t.issueId).map(a => a.detail);
    assert.ok(acts.some(d => d.includes('→in_progress (wake)')), 'wake reopen should leave an activity line');
  });

  it('rejects unknown comments and blank bodies', () => {
    const t = withComment();
    throwsWith(() => t.store.updateComment('nope', { body: 'x' }), NotFoundError, 'comment not found: nope');
    throwsWith(() => t.store.updateComment(t.commentId, { body: '   ' }), ValidationError, /blank/);
  });

  it('edit permission: only the human (web) may edit their own comments — agents locked out entirely', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const issueId = store.createIssue({ projectId: 'p1', title: 't' }).id;

    // 用户（web 面板）创建的评论：web 可改；agent 不可改。
    const userC = store.addComment(issueId, { author: 'web', body: 'user note' }).id;
    throwsWith(() => store.updateComment(userC, { body: 'agent sneak' }, 'sisyphus'), PermissionError, /only the.*who created/);
    store.updateComment(userC, { body: 'user edit ok' }, 'web');
    assert.equal(store.listComments(issueId)[0].body, 'user edit ok');

    // agent 创建的评论：连人工 web 也不能改（agent 的发言保持原样）。
    const agentC = store.addComment(issueId, { author: 'sisyphus', body: 'agent report' }).id;
    throwsWith(() => store.updateComment(agentC, { body: 'web rewrite' }, 'web'), PermissionError, /agents|created by/);
    throwsWith(() => store.updateComment(agentC, { body: 'agent self-edit' }, 'sisyphus'), PermissionError, /agents|created by/);

    // 匿名评论（历史数据、无签名）：归为用户可编辑。
    const anonC = store.addComment(issueId, { body: 'anon by default' }).id;
    store.updateComment(anonC, { body: 'rewrite by web' }, 'web');
    assert.equal(store.listComments(issueId).find(c => c.id === anonC)!.body, 'rewrite by web');

    // 状态推进不受权限限制：watch/agent 可以 processing/processed/回置 pending。
    store.updateComment(userC, { status: 'processing' }, 'watch');
    store.updateComment(userC, { status: 'processed' }, 'watch');
    store.updateComment(userC, { status: 'pending' }, 'sisyphus');
    assert.equal(store.listComments(issueId).find(c => c.id === userC)!.status, 'pending');
  });
});

// --- (h) duplicate project --------------------------------------------------------

describe('Store.createProject conflicts', () => {
  it('throws ConflictError on a duplicate project id', () => {
    const { store } = fresh();
    store.createProject({ id: 'demo', name: 'First' });
    throwsWith(
      () => store.createProject({ id: 'demo', name: 'Second' }),
      ConflictError,
      'project already exists: demo'
    );
  });
});

// --- (i) revision -------------------------------------------------------------------

describe('Store.revision', () => {
  it('increases after mutations', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const r0 = store.revision();

    const issue = store.createIssue({ projectId: 'p1', title: 'bump me' });
    const r1 = store.revision();
    assert.ok(r1 > r0, `revision should increase after createIssue (${r0} -> ${r1})`);

    store.updateIssue(issue.id, { status: 'in_progress' });
    const r2 = store.revision();
    assert.ok(r2 > r1, `revision should increase after updateIssue (${r1} -> ${r2})`);
  });
});

// --- (j) migrations ---------------------------------------------------------------

describe('migrations', () => {
  it('sets user_version to the latest migration on a fresh store (base schema + all migrations)', () => {
    const db = new DatabaseSync(':memory:');
    new Store('.unused', db); // configureDatabase runs schema + migrations
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(row.user_version, MIGRATIONS.length);
  });

  it('is idempotent: re-configuring an already-migrated db is a no-op', () => {
    const db = new DatabaseSync(':memory:');
    const store = new Store('.unused', db);
    store.createProject({ id: 'p1', name: 'P' });
    const issue = store.createIssue({ projectId: 'p1', title: 'survives' });
    // Second Store over the same db replays configureDatabase (idempotent path).
    new Store('.unused', db);
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(row.user_version, MIGRATIONS.length);
    assert.ok(store.getIssue(issue.id));
  });
});

// --- (k) start/due dates ----------------------------------------------------------

describe('start/due dates', () => {
  it('roundtrips null → "2026-01-15" → null on create/update', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });

    // create without dates → null
    const issue = store.createIssue({ projectId: 'p1', title: 'dated' });
    assert.equal(issue.startDate, null);
    assert.equal(issue.dueDate, null);

    // update sets both
    const set = store.updateIssue(issue.id, { startDate: '2026-01-15', dueDate: '2026-02-20' });
    assert.equal(set.startDate, '2026-01-15');
    assert.equal(set.dueDate, '2026-02-20');
    assert.equal(set.version, 2);

    // explicit null clears (not "absent leaves unchanged")
    const cleared = store.updateIssue(issue.id, { startDate: null, dueDate: null });
    assert.equal(cleared.startDate, null);
    assert.equal(cleared.dueDate, null);
  });

  it('creates with dates set directly on createIssue', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const issue = store.createIssue({ projectId: 'p1', title: 'born dated', startDate: '2026-01-15' });
    assert.equal(issue.startDate, '2026-01-15');
    assert.equal(issue.dueDate, null);
  });
});

// --- (l) activity stream ----------------------------------------------------------

describe('activity stream', () => {
  it('records created/updated/commented with the actor passed', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const id = store.createIssue({ projectId: 'p1', title: 'tracked' }, 'alice').id;
    store.updateIssue(id, { status: 'in_progress', title: 'tracked v2' }, undefined, 'bob', '开始执行：任务已领取。验证证据：工作分支已确认。未覆盖：编码与测试尚未完成。');
    store.addComment(id, { body: 'ship it' }, 'carol');

    // newest first: regular comment, audit comment, update, create
    const acts = store.listActivities(id);
    assert.equal(acts.length, 4);
    assert.deepEqual(acts.map(a => a.action), ['commented', 'commented', 'updated', 'created']);
    assert.deepEqual(acts.map(a => a.actor), ['carol', 'bob', 'bob', 'alice']);
    assert.equal(acts[0]!.detail, 'ship it');
    assert.equal(acts[0]!.issueId, id);
    assert.match(acts[1]!.detail, /状态变更记录：todo → in_progress/);
    // changed keys joined by ',' (colMap order); status spells out its transition
    assert.equal(acts[2]!.detail, 'title,status: todo→in_progress');
    assert.equal(acts[3]!.detail, 'tracked');
  });

  it('emits no activity when the patch is empty', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const id = store.createIssue({ projectId: 'p1', title: 'quiet' }).id;
    assert.equal(store.listActivities(id).length, 1);

    store.updateIssue(id, {});
    assert.equal(store.listActivities(id).length, 1);
  });

  it('defaults the actor to "" and truncates long comment detail to 200 chars', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const id = store.createIssue({ projectId: 'p1', title: 'anon' }).id;
    assert.equal(store.listActivities(id)[0]!.actor, '');

    const long = 'x'.repeat(250);
    store.addComment(id, { body: long });
    const commented = store.listActivities(id).find(a => a.action === 'commented');
    assert.ok(commented);
    assert.equal(commented.detail.length, 200);
  });
});

// --- (n) worktree binding (T2-8) ---------------------------------------------------

describe('worktree binding', () => {
  it('roundtrips create → update → null clears to empty string', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });

    // create with a worktree
    const issue = store.createIssue({ projectId: 'p1', title: 'wt', worktree: 'wt-x' });
    assert.equal(issue.worktree, 'wt-x');

    // update to another value (optimistic lock honored)
    const set = store.updateIssue(issue.id, { worktree: 'wt-y' }, 1);
    assert.equal(set.worktree, 'wt-y');
    assert.equal(set.version, 2);

    // explicit null clears to '' (column is NOT NULL DEFAULT '')
    const cleared = store.updateIssue(issue.id, { worktree: null });
    assert.equal(cleared.worktree, '');
    assert.equal(cleared.version, 3);
  });

  it('defaults worktree to empty string and lists it back', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const issue = store.createIssue({ projectId: 'p1', title: 'plain' });
    assert.equal(issue.worktree, '');
    assert.equal(store.listIssues('p1')[0]!.worktree, '');
    // null on create also normalizes to ''
    const nulled = store.createIssue({ projectId: 'p1', title: 'nulled', worktree: null });
    assert.equal(nulled.worktree, '');
  });
});

// --- (m) dependencies (T4-19) ------------------------------------------------------

describe('Store dependencies', () => {
  it('rejects a duplicate dependency edge instead of leaking a UNIQUE violation', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const x = store.createIssue({ projectId: 'p1', title: 'x' }).id;
    const y = store.createIssue({ projectId: 'p1', title: 'y' }).id;
    store.addDependency(x, y);
    throwsWith(() => store.addDependency(x, y), ValidationError, 'dependency already exists');
  });

  it('roundtrips add → list both directions → remove, logging dependency activities', () => {
    const { store } = fresh();
    const { A, C } = seedTwoProjects(store); // A, C top-level in p1
    store.addDependency(A, C, 'alice');

    // both sides of the edge: A is blocked by C; C blocks A
    assert.deepEqual(store.listDependencies(A), { blockedBy: [C], blocks: [] });
    assert.deepEqual(store.listDependencies(C), { blockedBy: [], blocks: [A] });
    // (sqlite rows are null-prototype; spread into plain objects for deep-equal)
    assert.deepEqual(store.projectDependencies('p1').map(e => ({ ...e })), [{ issueId: A, dependsOnId: C }]);
    assert.deepEqual(store.projectDependencies('p2'), []);

    // activity logged on the blocked issue
    const act = store.listActivities(A).find(a => a.action === 'dependency-added');
    assert.ok(act);
    assert.equal(act.actor, 'alice');
    assert.equal(act.detail, `depends on ${C}`);

    store.removeDependency(A, C, 'bob');
    assert.deepEqual(store.listDependencies(A), { blockedBy: [], blocks: [] });
    assert.deepEqual(store.listDependencies(C), { blockedBy: [], blocks: [] });
    assert.deepEqual(store.projectDependencies('p1'), []);
    assert.ok(store.listActivities(A).some(a => a.action === 'dependency-removed'));
  });

  it('rejects a self-dependency', () => {
    const { store } = fresh();
    const { A } = seedTwoProjects(store);
    throwsWith(() => store.addDependency(A, A), ValidationError, 'an issue cannot depend on itself');
  });

  it('rejects cross-project dependencies and missing issues (issueId checked first)', () => {
    const { store } = fresh();
    const { A, D } = seedTwoProjects(store);
    throwsWith(() => store.addDependency(A, D), ValidationError, 'dependencies must stay within one project');
    throwsWith(() => store.addDependency('ghost', A), NotFoundError, 'issue not found: ghost');
    throwsWith(() => store.addDependency(A, 'ghost'), NotFoundError, 'issue not found: ghost');
  });

  it('rejects a direct 2-cycle (A→B then B→A)', () => {
    const { store } = fresh();
    const { A, B } = seedTwoProjects(store);
    store.addDependency(A, B);
    throwsWith(() => store.addDependency(B, A), ValidationError, 'circular dependency detected');
  });

  it('rejects a transitive cycle (A→B, B→C, then C→A)', () => {
    const { store } = fresh();
    const { A, B, C } = seedTwoProjects(store);
    store.addDependency(A, B);
    store.addDependency(B, C);
    throwsWith(() => store.addDependency(C, A), ValidationError, 'circular dependency detected');
  });

  it('removeDependency validates issues and edge existence', () => {
    const { store } = fresh();
    const { A, C, D } = seedTwoProjects(store);
    throwsWith(() => store.removeDependency(A, 'ghost'), NotFoundError, 'issue not found: ghost');
    throwsWith(() => store.removeDependency(A, C), ValidationError, 'dependency does not exist');
    store.addDependency(A, C);
    throwsWith(() => store.removeDependency(A, D), ValidationError, 'dependency does not exist');
    store.removeDependency(A, C); // clean remove still fine
  });

  it('readyIssues: blocked issue not ready; done dependency unblocks; done issues excluded', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const A = store.createIssue({ projectId: 'p1', title: 'A', assignee: 'me' }).id;
    const B = store.createIssue({ projectId: 'p1', title: 'B' }).id;
    const C = store.createIssue({ projectId: 'p1', title: 'C' }).id;
    store.addDependency(A, B); // A blocked by B
    store.addDependency(B, C); // B blocked by C

    const ids = (list: { id: string }[]): string[] => list.map(i => i.id);
    // only C is ready (A blocked by todo B; B blocked by todo C)
    assert.deepEqual(ids(store.readyIssues('p1')), [C]);

    store.updateIssue(C, { status: 'done' });
    // C done → excluded; B unblocked → ready; A still blocked by B
    assert.deepEqual(ids(store.readyIssues('p1')), [B]);

    store.updateIssue(B, { status: 'done' });
    // B done → A unblocked; all deps done
    assert.deepEqual(ids(store.readyIssues('p1')), [A]);

    // assignee filter: A belongs to 'me'
    assert.deepEqual(ids(store.readyIssues('p1', { assignee: 'me' })), [A]);
    assert.deepEqual(ids(store.readyIssues('p1', { assignee: 'nobody' })), []);

    // priority order is preserved across ready candidates
    const X = store.createIssue({ projectId: 'p1', title: 'X', priority: 'urgent' }).id;
    assert.deepEqual(ids(store.readyIssues('p1')), [X, A]);
  });

  it('dependency edges cascade away when either endpoint issue is deleted', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const A = store.createIssue({ projectId: 'p1', title: 'A' }).id;
    const B = store.createIssue({ projectId: 'p1', title: 'B' }).id;
    const C = store.createIssue({ projectId: 'p1', title: 'C' }).id;
    store.addDependency(A, B);
    store.addDependency(C, A);

    // deleting the depends-on side (B) removes the A→B edge...
    store.deleteIssue(B);
    assert.deepEqual(store.listDependencies(A), { blockedBy: [], blocks: [C] });
    // ...and deleting the blocked side (A) removes the C→A edge
    store.deleteIssue(A);
    assert.deepEqual(store.listDependencies(C), { blockedBy: [], blocks: [] });
    assert.deepEqual(store.projectDependencies('p1'), []);
  });
});

// --- (o) archive (T5-24) -----------------------------------------------------------

describe('Store archive', () => {
  it('roundtrips archive → excluded from default list → only → unarchive → back; excluded from readyIssues', () => {
    const { store, events } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const A = store.createIssue({ projectId: 'p1', title: 'A' }).id;
    const B = store.createIssue({ projectId: 'p1', title: 'B' }).id;

    // archive bumps version + sets archivedAt, logs activity, emits issue.updated
    const arch = store.archiveIssue(A, 'alice');
    assert.ok(arch.archivedAt, 'archivedAt should be set');
    assert.equal(arch.version, 2, 'archive is a row mutation → version bump');
    const act = store.listActivities(A).find(a => a.action === 'archived');
    assert.ok(act);
    assert.equal(act.actor, 'alice');
    assert.ok(events.some(e => e.type === 'issue.updated' && e.payload.id === A));

    // default list excludes the archived row
    assert.deepEqual(store.listIssues('p1').map(i => i.id), [B]);
    // 'only' returns just it; 'all' returns both
    assert.deepEqual(store.listIssues('p1', { archived: 'only' }).map(i => i.id), [A]);
    assert.equal(store.listIssues('p1', { archived: 'all' }).length, 2);
    // readyIssues uses the listIssues default → archived excluded
    assert.deepEqual(store.readyIssues('p1').map(i => i.id), [B]);
    // progress uses the listIssues default too
    assert.equal(store.projectProgress('p1').total, 1);

    // unarchive → back in the default list, archivedAt null
    const un = store.unarchiveIssue(A, 'bob');
    assert.equal(un.archivedAt, null);
    assert.equal(un.version, 3);
    assert.equal(store.listIssues('p1').length, 2);
    assert.deepEqual(store.readyIssues('p1').map(i => i.id).sort(), [A, B].sort());
    assert.ok(store.listActivities(A).some(a => a.action === 'unarchived' && a.actor === 'bob'));

    // NotFound on unknown ids
    throwsWith(() => store.archiveIssue('ghost'), NotFoundError, 'issue not found: ghost');
    throwsWith(() => store.unarchiveIssue('ghost'), NotFoundError, 'issue not found: ghost');
  });

  it('archived issues stay out of search results', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const X = store.createIssue({ projectId: 'p1', title: 'searchable-findme' }).id;
    store.archiveIssue(X);
    assert.deepEqual(store.search('searchable-findme').map(i => i.id), []);
  });
});

// --- (q) claims / leases (T7-34) ----------------------------------------------------

describe('Store claims (T7-34)', () => {
  // Like fresh(), but keeps the injected DatabaseSync around so tests can
  // exec raw SQL against the same :memory: db (e.g. age a lease to expiry
  // deterministically instead of waiting out a wall-clock ttl).
  function freshDb(): { store: Store; db: DatabaseSync; events: StoreEvent[] } {
    const db = new DatabaseSync(':memory:');
    const store = new Store('.unused', db);
    const events: StoreEvent[] = [];
    store.subscribe(e => events.push(e));
    return { store, db, events };
  }

  function seed(store: Store): string {
    store.createProject({ id: 'p1', name: 'P' });
    return store.createIssue({ projectId: 'p1', title: 'leased' }).id;
  }

  it('claims, and a re-entrant claim by the same agent renews (version bumps each time)', () => {
    const { store } = freshDb();
    const id = seed(store);

    const first = store.claimIssue(id, 'alpha', 30);
    assert.equal(first.claimedBy, 'alpha');
    assert.equal(first.status, 'in_progress', 'claim auto-flows todo → in_progress');
    assert.equal(first.version, 3, 'claim bumps version twice (lease + auto-flow)');
    assert.ok(first.leaseExpiresAt);
    assert.ok(Date.parse(first.leaseExpiresAt!) > Date.now(), 'lease is in the future');

    // same agent claims again → renew, not a conflict; status untouched
    const second = store.claimIssue(id, 'alpha', 60);
    assert.equal(second.claimedBy, 'alpha');
    assert.equal(second.status, 'in_progress');
    assert.equal(second.version, 4, 're-claim bumps version again (lease only)');
    assert.ok(Date.parse(second.leaseExpiresAt!) >= Date.parse(first.leaseExpiresAt!));

    // activity logged per claim; auto-flow logged exactly once
    const claims = store.listActivities(id).filter(a => a.action === 'claimed');
    assert.equal(claims.length, 2);
    const flows = store.listActivities(id).filter(a => a.action === 'status' && a.detail === 'todo → in_progress (claim)');
    assert.equal(flows.length, 1, 'auto-flow logs once (first claim only)');
    assert.equal(claims[0]!.actor, 'alpha');
    assert.equal(claims[0]!.detail, 'by alpha ttl 60m');
  });

  it('claim auto-flow touches only todo: in_review and done stay put', () => {
    const { store } = freshDb();
    store.createProject({ id: 'p1', name: 'P' });
    const review = store.createIssue({ projectId: 'p1', title: 'in review' }).id;
    store.updateIssue(review, { status: 'in_review' }, 1);
    const done = store.createIssue({ projectId: 'p1', title: 'done' }).id;
    store.updateIssue(done, { status: 'done' }, 1);

    store.claimIssue(review, 'alpha', 30);
    assert.equal(store.getIssue(review)!.status, 'in_review', 'in_review not regressed');
    store.claimIssue(done, 'alpha', 30);
    assert.equal(store.getIssue(done)!.status, 'done', 'done not reopened');
    const flowed = store.listActivities(review).filter(a => a.action === 'status');
    assert.equal(flowed.length, 0, 'no auto-flow activity for non-todo');
  });

  it('claim cannot override the Session inherited from its Project', () => {
    const { store } = freshDb();
    store.createProject({ id: 'p1', name: 'P', defaultSessionId: 'ses_project' });
    const free = store.createIssue({ projectId: 'p1', title: 'unbound', sessionId: 'ses_issue' }).id;
    const taken = store.createIssue({ projectId: 'p1', title: 'already inherited' }).id;

    const claimed = store.claimIssue(free, 'alpha', 30, 'alpha', 'ses_agent');
    assert.equal(claimed.sessionId, 'ses_project');
    assert.equal(claimed.status, 'in_progress');
    assert.ok(!store.listActivities(free).some(a => a.action === 'session-bound'));

    const claimedAgain = store.claimIssue(taken, 'beta', 30, 'beta', 'ses_beta');
    assert.equal(claimedAgain.sessionId, 'ses_project', 'claim sessionId cannot override the Project');

    const renewed = store.claimIssue(free, 'alpha', 60);
    assert.equal(renewed.sessionId, 'ses_project');
  });

  it('claim records Agent branch but keeps Session inherited from Project', () => {
    const { store } = freshDb();
    store.createProject({ id: 'p1', name: 'P', defaultSessionId: 'ses_project' });
    const free = store.createIssue({ projectId: 'p1', title: 'unbound' }).id;
    const takenBranch = store.createIssue({ projectId: 'p1', title: 'branch prebound' }).id;
    store.updateIssue(takenBranch, { branch: 'feat/prebound' }, 1);

    const claimed = store.claimIssue(free, 'alpha', 30, 'alpha', 'ses_agent', 'feat/agent-run');
    assert.equal(claimed.branch, 'feat/agent-run');
    assert.equal(claimed.sessionId, 'ses_project');
    assert.equal(claimed.status, 'in_progress');
    assert.ok(store.listActivities(free).some(a => a.action === 'branch-bound' && a.detail === 'feat/agent-run'));

    const other = store.claimIssue(takenBranch, 'beta', 30, 'beta', 'ses_beta', 'feat/other');
    assert.equal(other.branch, 'feat/prebound', 'existing branch never overwritten');
    assert.equal(other.sessionId, 'ses_project');

    const renewed = store.claimIssue(free, 'alpha', 60, 'alpha', 'ses_mine', 'feat/agent-run');
    assert.equal(renewed.branch, 'feat/agent-run');
    assert.equal(renewed.sessionId, 'ses_project');
  });

  it('a child starting (claim or manual move) pulls a todo parent to in_progress — one-way, human statuses untouched', () => {
    const { store } = freshDb();
    store.createProject({ id: 'p1', name: 'P' });
    const parent = store.createIssue({ projectId: 'p1', title: 'parent' }).id;
    const c1 = store.createIssue({ projectId: 'p1', title: 'child 1', parentId: parent }).id;
    const c2 = store.createIssue({ projectId: 'p1', title: 'child 2', parentId: parent }).id;

    // 子任务 claim → 父 todo 被拉起 + 活动留痕
    store.claimIssue(c1, 'alpha', 30);
    assert.equal(store.getIssue(parent)!.status, 'in_progress', 'parent pulled by child claim');
    assert.ok(store.listActivities(parent).some(a => a.detail?.includes('(child started)')));

    // 父已 in_progress：再次拉起是 no-op（不重复活动）
    const actsBefore = store.listActivities(parent).length;
    store.claimIssue(c2, 'alpha', 30);
    assert.equal(store.getIssue(parent)!.status, 'in_progress');
    assert.equal(store.listActivities(parent).length, actsBefore);

    // 父 in_review / done：子开工不回退、不动（parent 已被 rollup 到 v2）
    store.updateIssue(parent, { status: 'in_review' }, 2);
    const c3 = store.createIssue({ projectId: 'p1', title: 'child 3', parentId: parent }).id;
    store.updateIssue(c3, { status: 'in_progress' }, 1);
    assert.equal(store.getIssue(parent)!.status, 'in_review', 'in_review untouched');

    const p2 = store.createIssue({ projectId: 'p1', title: 'done parent' }).id;
    store.updateIssue(p2, { status: 'done' }, 1);
    const c4 = store.createIssue({ projectId: 'p1', title: 'child 4', parentId: p2 }).id;
    store.updateIssue(c4, { status: 'in_progress' }, 1);
    assert.equal(store.getIssue(p2)!.status, 'done', 'done untouched');

    // 手动 update 路径同样拉起：新父 + todo
    const p3 = store.createIssue({ projectId: 'p1', title: 'manual parent' }).id;
    const c5 = store.createIssue({ projectId: 'p1', title: 'child 5', parentId: p3 }).id;
    store.updateIssue(c5, { status: 'in_progress' }, 1);
    assert.equal(store.getIssue(p3)!.status, 'in_progress', 'manual update path also rolls up');
  });

  it('rolls a parent up to in_review when every child waits for review or is done', () => {
    const { store } = freshDb();
    store.createProject({ id: 'p1', name: 'P' });
    const parent = store.createIssue({ projectId: 'p1', title: 'parent' }).id;
    const c1 = store.createIssue({ projectId: 'p1', title: 'child 1', parentId: parent }).id;
    const c2 = store.createIssue({ projectId: 'p1', title: 'child 2', parentId: parent }).id;

    store.updateIssue(c1, { status: 'in_review' }, 1);
    assert.equal(store.getIssue(parent)!.status, 'todo', 'one child still todo keeps the parent untouched');

    store.updateIssue(c2, { status: 'in_review' }, 1);
    assert.equal(store.getIssue(parent)!.status, 'in_review', 'all children waiting for review');
    assert.ok(store.listActivities(parent).some(a => a.detail?.includes('all children waiting for review')));

    // A done child plus an in_review child also makes the parent ready for review,
    // but never auto-completes it.
    const p2 = store.createIssue({ projectId: 'p1', title: 'done + review' }).id;
    const d1 = store.createIssue({ projectId: 'p1', title: 'done child', parentId: p2 }).id;
    const r1 = store.createIssue({ projectId: 'p1', title: 'review child', parentId: p2 }).id;
    store.updateIssue(d1, { status: 'done' }, 1);
    store.updateIssue(r1, { status: 'in_review' }, 1);
    assert.equal(store.getIssue(p2)!.status, 'in_review');
    assert.notEqual(store.getIssue(p2)!.status, 'done');

    const p3 = store.createIssue({ projectId: 'p1', title: 'all done' }).id;
    const d2 = store.createIssue({ projectId: 'p1', title: 'child 5', parentId: p3 }).id;
    const d3 = store.createIssue({ projectId: 'p1', title: 'child 6', parentId: p3 }).id;
    store.updateIssue(d2, { status: 'done' }, 1);
    store.updateIssue(d3, { status: 'done' }, 1);
    assert.equal(store.getIssue(p3)!.status, 'in_review', 'all children done rolls to review, never done');
  });

  it('rejects a second agent while the lease is active — exact ConflictError message', () => {
    const { store } = freshDb();
    const id = seed(store);
    const claimed = store.claimIssue(id, 'alpha', 30);

    throwsWith(
      () => store.claimIssue(id, 'beta', 30),
      ConflictError,
      `issue claimed by alpha until ${claimed.leaseExpiresAt}`
    );
  });

  it('an expired lease is claimable by a second agent (lazy expiry)', () => {
    const { store, db } = freshDb();
    const id = seed(store);
    store.claimIssue(id, 'alpha', 30);
    // age the lease deterministically: raw SQL on the injected db
    db.exec(`UPDATE issues SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = '${id}'`);

    const taken = store.claimIssue(id, 'beta', 30);
    assert.equal(taken.claimedBy, 'beta', 'expired lease reads as unclaimed');
    assert.ok(Date.parse(taken.leaseExpiresAt!) > Date.now());
  });

  it('heartbeat by the holder extends the lease and bumps nothing', () => {
    const { store, db } = freshDb();
    const id = seed(store);
    store.claimIssue(id, 'alpha', 1); // v3: lease + auto-flow
    const before = store.getIssue(id);
    assert.ok(before);
    const actsBefore = store.listActivities(id).length;

    const beat = store.heartbeatIssue(id, 'alpha', 60);
    assert.ok(Date.parse(beat.leaseExpiresAt!) > Date.parse(before.leaseExpiresAt!),
      'lease deadline extended');
    assert.equal(beat.version, before.version, 'heartbeat does NOT bump version');
    assert.equal(beat.updatedAt, before.updatedAt, 'heartbeat does NOT touch updated_at');
    assert.equal(store.listActivities(id).length, actsBefore, 'heartbeat logs no activity');
    // row check: only lease_expires_at moved
    const row = db.prepare('SELECT claimed_by, claimed_at, version FROM issues WHERE id = ?').get(id) as { claimed_by: string; claimed_at: string | null; version: number };
    assert.equal(row.claimed_by, 'alpha');
    assert.ok(row.claimed_at);
    assert.equal(row.version, 3);
  });

  it('heartbeat by a non-holder → ConflictError; heartbeat on an expired lease → claim again', () => {
    const { store, db } = freshDb();
    const id = seed(store);
    store.claimIssue(id, 'alpha', 30);

    throwsWith(() => store.heartbeatIssue(id, 'beta'), ConflictError, 'not the lease holder');

    db.exec(`UPDATE issues SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = '${id}'`);
    throwsWith(() => store.heartbeatIssue(id, 'alpha'), ConflictError, 'lease expired, claim again');
  });

  it('release clears the claim and bumps version; releasing an unclaimed issue is a no-op', () => {
    const { store, events } = freshDb();
    const id = seed(store);
    store.claimIssue(id, 'alpha', 30); // v3: lease + auto-flow

    const released = store.releaseIssue(id, 'alpha');
    assert.equal(released.claimedBy, '', 'claim cleared');
    assert.equal(released.leaseExpiresAt, null, 'lease cleared');
    assert.equal(released.version, 4, 'release bumps version');
    const act = store.listActivities(id).find(a => a.action === 'released');
    assert.ok(act);
    assert.equal(act.actor, 'alpha');
    assert.equal(act.detail, 'by alpha');
    assert.ok(events.some(e => e.type === 'issue.updated' && e.payload.id === id));

    // no-op release: no version bump, no extra activity
    const again = store.releaseIssue(id, 'alpha');
    assert.equal(again.version, 4, 'no-op release does not bump version');
    assert.equal(store.listActivities(id).filter(a => a.action === 'released').length, 1);
  });

  it('release by a non-holder → ConflictError', () => {
    const { store } = freshDb();
    const id = seed(store);
    store.claimIssue(id, 'alpha', 30);
    throwsWith(() => store.releaseIssue(id, 'beta'), ConflictError, 'not the lease holder');
  });

  it('readyIssues claimAgent excludes others’ active claims, keeps own and expired ones', () => {
    const { store, db } = freshDb();
    store.createProject({ id: 'p1', name: 'P' });
    const A = store.createIssue({ projectId: 'p1', title: 'A' }).id;
    const B = store.createIssue({ projectId: 'p1', title: 'B' }).id;
    const C = store.createIssue({ projectId: 'p1', title: 'C' }).id;

    store.claimIssue(A, 'beta', 30);   // someone else's active claim
    store.claimIssue(B, 'me', 30);     // my own claim
    store.claimIssue(C, 'beta', 30);   // will be aged to expiry
    db.exec(`UPDATE issues SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = '${C}'`);

    const ids = (list: { id: string }[]): string[] => list.map(i => i.id);
    // from my perspective: A excluded, B kept (own), C kept (expired)
    assert.deepEqual(ids(store.readyIssues('p1', { claimAgent: 'me' })), [B, C]);
    // default (no claimAgent): everything stays visible for the UI
    assert.deepEqual(ids(store.readyIssues('p1')).sort(), [A, B, C].sort());
    // from beta's perspective: A/C are theirs, B is mine
    assert.deepEqual(ids(store.readyIssues('p1', { claimAgent: 'beta' })).sort(), [A, C].sort());
  });

  it('validates inputs: empty agent, unknown issue', () => {
    const { store } = freshDb();
    const id = seed(store);
    throwsWith(() => store.claimIssue(id, ''), ValidationError, 'agent must be non-empty');
    throwsWith(() => store.heartbeatIssue(id, ''), ValidationError, 'agent must be non-empty');
    throwsWith(() => store.releaseIssue(id, ''), ValidationError, 'agent must be non-empty');
    throwsWith(() => store.claimIssue('ghost', 'alpha'), NotFoundError, 'issue not found: ghost');
    throwsWith(() => store.heartbeatIssue('ghost', 'alpha'), NotFoundError, 'issue not found: ghost');
    throwsWith(() => store.releaseIssue('ghost', 'alpha'), NotFoundError, 'issue not found: ghost');
  });
});

// --- (s) attachments (T7-39) ---------------------------------------------------------

describe('Store attachments (T7-39)', () => {
  // Like fresh(), but with a private temp attachmentsDir wired through the
  // Store constructor param — the on-disk seam under test.
  function freshDir(): { store: Store; dir: string; events: StoreEvent[] } {
    const dir = mkdtempSync(join(tmpdir(), 'taskboard-attachments-'));
    const store = new Store('.unused', new DatabaseSync(':memory:'), dir);
    const events: StoreEvent[] = [];
    store.subscribe(e => events.push(e));
    return { store, dir, events };
  }

  function seed(store: Store): string {
    store.createProject({ id: 'p1', name: 'P' });
    return store.createIssue({ projectId: 'p1', title: 'has files' }).id;
  }

  it('records and lists attachments (created order); logs activity, emits issue.updated, bumps revision', () => {
    const { store, events } = freshDir();
    const id = seed(store);
    const rev0 = store.revision();

    const a1 = store.addAttachment(id, 'spec.pdf', 1024, 'alice');
    const a2 = store.addAttachment(id, 'logo.png', 2048, 'bob');

    assert.equal(a1.issueId, id);
    assert.equal(a1.size, 1024);
    assert.equal(a1.actor, 'alice');
    assert.ok(a1.id.length > 0);
    // listByIssue: created_at ASC — insertion order via the rowid tie-breaker.
    assert.deepEqual(store.listAttachments(id).map(a => a.filename), ['spec.pdf', 'logo.png']);
    assert.deepEqual(store.listAttachments(id).map(a => a.id), [a1.id, a2.id]);
    // detail payload source: listAttachments is exactly what the show route ships.
    const detail = store.listAttachments(id);
    assert.deepEqual(detail.map(({ ...a }) => a), [
      { id: a1.id, issueId: id, filename: 'spec.pdf', size: 1024, actor: 'alice', createdAt: a1.createdAt },
      { id: a2.id, issueId: id, filename: 'logo.png', size: 2048, actor: 'bob', createdAt: a2.createdAt }
    ]);
    // activity: action 'attachment', detail = filename, actor propagated
    const acts = store.listActivities(id).filter(a => a.action === 'attachment');
    assert.equal(acts.length, 2);
    assert.equal(acts[1]!.actor, 'alice');
    assert.equal(acts[1]!.detail, 'spec.pdf');
    assert.equal(acts[0]!.actor, 'bob');
    assert.equal(acts[0]!.detail, 'logo.png');
    // event + revision (attachments feed the revision counter → SSE refresh)
    assert.ok(events.some(e => e.type === 'issue.updated' && e.payload.id === id));
    assert.ok(store.revision() > rev0, 'attachment insert must bump revision');

    // unknown issue → NotFoundError; getAttachment round-trips
    throwsWith(() => store.addAttachment('ghost', 'x', 1), NotFoundError, 'issue not found: ghost');
    assert.equal(store.getAttachment(a1.id)!.filename, 'spec.pdf');
    assert.equal(store.getAttachment('nope'), undefined);
  });

  it('enforces per-issue attachment quotas: ≤20 files, ≤50MB total; messages carry current usage', () => {
    const { store } = freshDir();
    const id = seed(store);
    const other = store.createIssue({ projectId: 'p1', title: 'other issue' }).id;

    for (let i = 0; i < 20; i++) store.addAttachment(id, `f${i}.txt`, 1, 'alice');
    throwsWith(() => store.addAttachment(id, 'over.txt', 1, 'alice'), ValidationError, /attachment quota exceeded: .* 20\/20 files/);

    // size quota uses recorded metadata only — fake big sizes, no real buffers.
    // 50MB - 20 bytes headroom: exactly-at-quota accepts, one byte over rejects.
    const big = store.createIssue({ projectId: 'p1', title: 'big' }).id;
    store.addAttachment(big, 'huge.bin', 50 * 1024 * 1024 - 20, 'alice');
    throwsWith(() => store.addAttachment(big, 'onemore.bin', 21, 'alice'), ValidationError, /bytes used of 52428800 byte quota/);

    // quotas are per-issue: the untouched issue still accepts freely.
    store.addAttachment(other, 'fine.txt', 1024, 'alice');
    assert.equal(store.listAttachments(other).length, 1);
  });

  it('pathFor lands under the injected dir and creates it on demand; deleteIssue removes rows AND the dir', () => {
    const { store, dir } = freshDir();
    const id = seed(store);
    const a = store.addAttachment(id, 'notes.txt', 5, 'alice');
    const path = store.attachmentPathFor(id, a.id, 'notes.txt');
    // <dir>/<issueId>/<attachmentId>__<filename>
    assert.equal(path, join(join(dir, id), `${a.id}__notes.txt`));
    assert.ok(existsSync(join(dir, id)), 'dirFor creates the per-issue dir');
    // seed a fake body the way the server route does
    writeFileSync(path, 'hello');
    assert.ok(existsSync(path));
    assert.equal(store.listAttachments(id).length, 1);

    store.deleteIssue(id);

    // DB rows cascaded via FK…
    assert.equal(store.listAttachments(id).length, 0);
    assert.equal(store.getAttachment(a.id), undefined);
    // …and the on-disk dir removed best-effort
    assert.ok(!existsSync(join(dir, id)), `attachment dir should be gone: ${join(dir, id)}`);
  });

  it('deleteProject also removes the project issues’ attachment dirs', () => {
    const { store, dir } = freshDir();
    store.createProject({ id: 'px', name: 'Doomed' });
    const i1 = store.createIssue({ projectId: 'px', title: 'one' }).id;
    const a = store.addAttachment(i1, 'doomed.txt', 3, 'alice');
    writeFileSync(store.attachmentPathFor(i1, a.id, 'doomed.txt'), 'bye');

    store.deleteProject('px');

    assert.equal(store.getAttachment(a.id), undefined);
    assert.ok(!existsSync(join(dir, i1)));
  });

  it('deleteAttachment removes row AND body, logs activity, emits issue.updated', () => {
    const { store, events } = freshDir();
    const id = seed(store);
    const a = store.addAttachment(id, 'gone.txt', 4, 'alice');
    const path = store.attachmentPathFor(id, a.id, 'gone.txt');
    writeFileSync(path, 'data');
    assert.ok(existsSync(path));
    events.length = 0;

    store.deleteAttachment(a.id, 'bob');

    assert.equal(store.getAttachment(a.id), undefined);
    assert.deepEqual(store.listAttachments(id), []);
    assert.ok(!existsSync(path), `body should be unlinked: ${path}`);
    const removed = store.listActivities(id).filter(x => x.action === 'attachment-removed');
    assert.equal(removed.length, 1);
    assert.equal(removed[0]!.actor, 'bob');
    assert.equal(removed[0]!.detail, 'gone.txt');
    assert.ok(events.some(e => e.type === 'issue.updated' && e.payload.id === id));
  });

  it('deleteAttachment throws NotFoundError for an unknown id', () => {
    const { store } = freshDir();
    seed(store);
    throwsWith(() => store.deleteAttachment('ghost'), NotFoundError, 'attachment not found: ghost');
  });

  it('deleteAttachment still succeeds when the body file is already missing', () => {
    const { store, dir } = freshDir();
    const id = seed(store);
    // Metadata-only row: the body was never written (or was removed out-of-band).
    const a = store.addAttachment(id, 'nofile.txt', 1, 'alice');

    store.deleteAttachment(a.id);

    assert.equal(store.getAttachment(a.id), undefined);
    assert.deepEqual(store.listAttachments(id), []);
    // Unlink must not mkdir the per-issue dir just to fail on a missing body.
    assert.ok(!existsSync(join(dir, id)));
  });
});

// --- (p) full-text search (T6-30) ----------------------------------------------------

describe('Store.search (FTS)', () => {
  it('finds by title substring AND by comment body (trigram, ≥3 chars); comment hit maps to parent', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const X = store.createIssue({ projectId: 'p1', title: 'hunt the trigram-haystack now' }).id;
    const Y = store.createIssue({ projectId: 'p1', title: 'plain title' }).id;
    store.addComment(Y, { body: 'needle-in-comments was spotted here' });

    // title substring via trigram
    assert.deepEqual(store.search('trigram-haystack').map(i => i.id), [X]);
    // comment body hit maps to the parent issue
    assert.deepEqual(store.search('needle-in-comments').map(i => i.id), [Y]);
    // no false positives
    assert.deepEqual(store.search('zebra-nowhere').map(i => i.id), []);
  });

  it('falls back to LIKE for short queries (<3 chars), case-insensitive over title/description', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const X = store.createIssue({ projectId: 'p1', title: 'Hunter' }).id;
    store.createIssue({ projectId: 'p1', title: 'plain', description: 'hunting season' });

    // 2-char query → LIKE path; case-insensitive; matches both title and description
    const ids = store.search('HU').map(i => i.id);
    assert.equal(ids.length, 2);
    assert.ok(ids.includes(X));
  });

  it('keeps the index in sync: update reindexes, delete removes, project delete clears', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const X = store.createIssue({ projectId: 'p1', title: 'before-rename' }).id;

    // description is indexed on create
    const D = store.createIssue({ projectId: 'p1', title: 'untitled', description: 'unique-desc-token' }).id;
    assert.deepEqual(store.search('unique-desc-token').map(i => i.id), [D]);

    // rename: new title found, old title gone
    store.updateIssue(X, { title: 'after-rename' });
    assert.deepEqual(store.search('after-rename').map(i => i.id), [X]);
    assert.deepEqual(store.search('before-rename').map(i => i.id), []);

    // delete: issue rows + its comment rows leave the index
    store.addComment(X, { body: 'comment-goes-too' });
    assert.deepEqual(store.search('comment-goes-too').map(i => i.id), [X]);
    store.deleteIssue(X);
    assert.deepEqual(store.search('after-rename').map(i => i.id), []);
    assert.deepEqual(store.search('comment-goes-too').map(i => i.id), []);

    // project delete clears everything (incl. comment fts rows of other issues)
    const Z = store.createIssue({ projectId: 'p1', title: 'doomed-issue' }).id;
    store.addComment(Z, { body: 'doomed-comment-token' });
    store.deleteProject('p1');
    assert.deepEqual(store.search('doomed-issue').map(i => i.id), []);
    assert.deepEqual(store.search('doomed-comment-token').map(i => i.id), []);
    assert.deepEqual(store.search('unique-desc-token').map(i => i.id), []);
  });

  it('quotes the query so FTS metacharacters cannot break the syntax', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    store.createIssue({ projectId: 'p1', title: 'plain words here' });
    // quotes / operators in user input are neutralized, not errors
    assert.deepEqual(store.search('"plain" OR x').map(i => i.title), []);
    assert.doesNotThrow(() => store.search('a " b'));
  });
});

// --- (r) project stats (T6-31) --------------------------------------------------------

describe('Store.projectStats', () => {
  it('aggregates byStatus / weeklyDone / avgCycleHours / byActor for a mixed project', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    // 2 done (created then updated via the store), 1 open; actors: alice
    // mutates, bob comments once.
    const a = store.createIssue({ projectId: 'p1', title: 'A' }, 'alice').id;
    const b = store.createIssue({ projectId: 'p1', title: 'B' }, 'alice').id;
    store.createIssue({ projectId: 'p1', title: 'C open' }, 'alice');
    store.updateIssue(a, { status: 'done' }, undefined, 'alice', '完成原因：需求实现完成。验证证据：定向测试通过。未覆盖：浏览器视觉验收。');
    store.updateIssue(b, { status: 'in_progress' }, undefined, 'alice', '开始执行：已开始实现。验证证据：分支与任务范围已确认。未覆盖：实现和测试。');
    store.updateIssue(b, { status: 'done' }, undefined, 'alice', '完成原因：任务实现完成。验证证据：单测通过。未覆盖：端到端验证。');
    store.addComment(a, { body: 'nice' }, 'bob');

    const stats = store.projectStats('p1');

    // byStatus: STATUSES order, zeros included
    assert.deepEqual(stats.byStatus.map(({ ...s }) => s), [
      { status: 'todo', count: 1 },
      { status: 'in_progress', count: 0 },
      { status: 'in_review', count: 0 },
      { status: 'done', count: 2 }
    ]);

    // weeklyDone: 8 zero-filled buckets oldest → newest; both done issues
    // landed just now, so the current (last) week carries them.
    assert.equal(stats.weeklyDone.length, 8);
    assert.equal(stats.weeklyDone.filter(w => w.count === 0).length, 7);
    assert.equal(stats.weeklyDone[7]!.count, 2);
    // weekStart is the LOCAL Monday (Mon 00:00) of the current week, ISO date
    const now = new Date();
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
    const p2 = (n: number): string => String(n).padStart(2, '0');
    assert.equal(stats.weeklyDone[7]!.weekStart,
      `${monday.getFullYear()}-${p2(monday.getMonth() + 1)}-${p2(monday.getDate())}`);

    // avgCycleHours: a number ≥ 0 once done issues exist (they were done
    // milliseconds after creation, so ~0.0)
    assert.equal(typeof stats.avgCycleHours, 'number');
    assert.ok(stats.avgCycleHours! >= 0);
    assert.ok(stats.avgCycleHours! < 1, 'cycle of a just-completed issue should round to 0.0');

    // byActor: alice = 3 creates + 3 updates + 3 atomic audit comments = 9, bob = 1 comment; desc order
    // (sqlite rows are null-prototype; spread for deep-equal)
    const alice = stats.byActor.find(x => x.actor === 'alice');
    assert.ok(alice, 'alice should appear in byActor');
    assert.equal(alice!.actions, 9);
    assert.equal(stats.byActor[0]!.actor, 'alice');
    assert.deepEqual({ ...stats.byActor[1]! }, { actor: 'bob', actions: 1 });
  });

  it('returns zeroed stats and null avgCycleHours for an empty project', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const stats = store.projectStats('p1');
    assert.equal(stats.avgCycleHours, null);
    assert.equal(stats.weeklyDone.length, 8);
    assert.ok(stats.weeklyDone.every(w => w.count === 0));
    assert.deepEqual(stats.byActor, []);
    assert.deepEqual(stats.byStatus.map(s => s.count), [0, 0, 0, 0]);
  });

  it('honors the weeks option (length changes) and clamps to 1..26', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    assert.equal(store.projectStats('p1', { weeks: 2 }).weeklyDone.length, 2);
    assert.equal(store.projectStats('p1', { weeks: 0 }).weeklyDone.length, 1);
    assert.equal(store.projectStats('p1', { weeks: 99 }).weeklyDone.length, 26);
    // successive weekStarts step back exactly 7 days, oldest → newest
    const w = store.projectStats('p1', { weeks: 3 }).weeklyDone;
    const dayMs = 86_400_000;
    assert.equal(Date.parse(w[1]!.weekStart) - Date.parse(w[0]!.weekStart), 7 * dayMs);
    assert.equal(Date.parse(w[2]!.weekStart) - Date.parse(w[1]!.weekStart), 7 * dayMs);
  });

  it('scopes byActor to the project via the activities ⋈ issues JOIN', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'One' });
    store.createProject({ id: 'p2', name: 'Two' });
    const a = store.createIssue({ projectId: 'p1', title: 'A' }, 'alice').id;
    store.createIssue({ projectId: 'p2', title: 'B' }, 'zoe');
    store.updateIssue(a, { status: 'done' }, undefined, 'alice', '完结原因：测试任务完成。验证证据：Store 测试覆盖。未覆盖：无。');

    const s1 = store.projectStats('p1');
    assert.deepEqual(s1.byActor.map(x => ({ ...x })), [{ actor: 'alice', actions: 3 }]); // zoe's p2 activity is excluded
    const s2 = store.projectStats('p2');
    assert.deepEqual(s2.byActor.map(x => ({ ...x })), [{ actor: 'zoe', actions: 1 }]);
  });
});



describe('Store.backupTo', () => {
  it('writes a taskboard-*.sqlite snapshot into dir and returns its path', () => {
    const backupDir = mkdtempSync(join(tmpdir(), 'taskboard-backups-'));
    try {
      // fresh() is an in-memory db — VACUUM INTO serializes it to the file.
      const { store } = fresh();
      store.createProject({ id: 'p1', name: 'P' });
      store.createIssue({ projectId: 'p1', title: 'snapshot me' });

      const file = store.backupTo(backupDir);
      assert.ok(file.startsWith(backupDir), `backup inside dir: ${file}`);
      assert.match(file.split(/[\\/]/).pop() ?? '', /^taskboard-\d{8}-\d{6}\.sqlite$/);
      assert.ok(existsSync(file), 'backup file exists');
      assert.ok(statSync(file).size > 0, 'backup file not empty');

      // the snapshot is a readable sqlite db containing our data
      const copy = new DatabaseSync(file);
      const rows = copy.prepare('SELECT id FROM projects').all() as { id: string }[];
      assert.deepEqual(rows.map(r => r.id), ['p1']);
      copy.close();
    } finally {
      rmSync(backupDir, { recursive: true, force: true });
    }
  });

  it('rejects paths containing NUL bytes', () => {
    const { store } = fresh();
    throwsWith(() => store.backupTo('bad\0dir'), ValidationError, /NUL/);
  });
});

// --- 评审修复回归（2026-10-16 双轴评审 round-2） ---

describe('review regression: archive × ready (T5-24 × T4-20/21)', () => {
  it('done-then-archived dependency does NOT block its dependents', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const dep = store.createIssue({ projectId: 'p1', title: 'dep' }).id;
    const blocked = store.createIssue({ projectId: 'p1', title: 'blocked', parentId: null }).id;
    store.addDependency(blocked, dep);

    // 归档前：dep todo → blocked 不就绪
    assert.ok(!store.readyIssues('p1').some(i => i.id === blocked));

    store.updateIssue(dep, { status: 'done' });
    store.archiveIssue(dep);
    // dep 已 done（即使被归档）→ 下游就绪
    assert.ok(store.readyIssues('p1').some(i => i.id === blocked));
  });

  it('archived TODO dependency still blocks (status map widened, blocking semantics kept)', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const dep = store.createIssue({ projectId: 'p1', title: 'dep' }).id;
    const blocked = store.createIssue({ projectId: 'p1', title: 'blocked' }).id;
    store.addDependency(blocked, dep);
    store.archiveIssue(dep);
    assert.ok(!store.readyIssues('p1').some(i => i.id === blocked));
  });
});

describe('review regression: LIKE fallback hits comments (T6-30)', () => {
  it('2-char query reaches comment bodies via the LIKE path', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const id = store.createIssue({ projectId: 'p1', title: 'plain' }).id;
    store.addComment(id, { body: 'xy marker in comment' });
    assert.deepEqual(store.search('xy').map(i => i.id), [id]);
  });
});

describe('review regression: claim release idempotent no-op (T7-34 CAS)', () => {
  it('releasing an unclaimed issue succeeds without version bump or event', () => {
    const { store, events } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const id = store.createIssue({ projectId: 'p1', title: 't' }).id;
    const v0 = store.getIssue(id)!.version;
    const after = store.releaseIssue(id, 'someone');
    assert.equal(after.version, v0);
    assert.equal(events.filter(e => e.type === 'issue.updated').length, 0);
  });
});

describe('review regression: confirm escape-hatch schema (T7-36)', () => {
  it('restUpdateIssueSchema accepts confirm alongside status/version', () => {
    const parsed = restUpdateIssueSchema.safeParse({ status: 'done', version: 1, confirm: true });
    assert.equal(parsed.success, true);
  });
});

// --- Directory workspace metadata; OpenCode URL is deployment configuration. ----

describe('Directory-owned workspace metadata', () => {
  it('legacy project creation seeds a Directory without an OpenCode URL', () => {
    const { store } = fresh();
    const project = store.createProject({ id: 'p1', name: 'P', workspacePath: '/workspace/a' });
    assert.equal(project.workspacePath, '/workspace/a');
    assert.ok(project.directoryId);
    assert.equal(store.getDirectory(project.directoryId!)!.workspacePath, '/workspace/a');
    assert.equal('serverUrl' in store.getDirectory(project.directoryId!)!, false);
    assert.equal('wakeChannel' in project, false);
  });

  it('updates the Directory workspace while preserving inherited Session bindings and history', () => {
    const { store, events } = fresh();
    const directory = store.createDirectory({ id: 'dir-1', name: 'D', workspacePath: '/workspace/a' });
    const project = store.createProject({ id: 'p1', name: 'P', directoryId: directory.id, defaultSessionId: 'ses_project' });
    const issue = store.createIssue({ projectId: project.id, title: 'A' });

    store.updateDirectory(directory.id, { workspacePath: '/workspace/b' });

    assert.equal(store.getDirectory(directory.id)!.workspacePath, '/workspace/b');
    assert.equal(store.getProject('p1')!.workspacePath, '/workspace/b');
    assert.equal('wakeChannel' in store.getProject('p1')!, false);
    assert.equal(store.getProject('p1')!.defaultSessionId, 'ses_project');
    assert.equal(store.getIssue(issue.id)!.sessionId, 'ses_project');
    assert.ok(!store.listActivities(issue.id).some(activity => activity.action === 'session-unbound'));

    const upd = events.find(e => e.type === 'project.updated');
    assert.ok(upd);
    assert.deepEqual(upd!.payload.fields, ['workspacePath']);
    assert.ok(!events.some(event =>
      event.type === 'issue.updated'
      && event.payload.id === issue.id
      && Array.isArray(event.payload.fields)
      && event.payload.fields.includes('sessionId')
    ));
  });

  it('does not allow workspace changes while a task has an active Agent lease', () => {
    const { store } = fresh();
    const directory = store.createDirectory({ id: 'dir-1', name: 'D', workspacePath: '/workspace/a' });
    const project = store.createProject({ id: 'p1', name: 'P', directoryId: directory.id });
    const issue = store.createIssue({ projectId: project.id, title: 'leased' });
    store.claimIssue(issue.id, 'agent-a', 30);
    assert.throws(() => store.updateDirectory(directory.id, { workspacePath: '/workspace/b' }), /active agent leases/);
    assert.equal(store.getDirectory(directory.id)!.workspacePath, '/workspace/a');
    assert.equal(store.getProject(project.id)!.workspacePath, '/workspace/a');
  });
});

describe('workspace directories', () => {
  it('inherits the directory workspace path when creating a project without an override', () => {
    const store = new Store(':memory:', new DatabaseSync(':memory:'));
    const directory = store.createDirectory({
      id: 'work-a', name: 'Workspace A', workspacePath: 'D:\\workspace\\project-a'
    });
    const project = store.createProject({
      id: 'p-a', name: 'Project A', directoryId: directory.id, defaultSessionId: 'ses_a'
    });
    assert.equal(project.directoryId, directory.id);
    assert.equal(directory.workspacePath, 'D:\\workspace\\project-a');
    assert.equal(project.workspacePath, 'D:\\workspace\\project-a');
    assert.equal('wakeChannel' in project, false);
    assert.equal(project.defaultSessionId, 'ses_a');
    assert.deepEqual(store.listDirectories().map(item => item.id), ['work-a']);
  });

  it('Directory path changes are immediately inherited by existing and new projects', () => {
    const store = new Store(':memory:', new DatabaseSync(':memory:'));
    const directory = store.createDirectory({
      id: 'work-b', name: 'Workspace B', workspacePath: 'D:\\workspace\\old-root'
    });
    const existing = store.createProject({
      id: 'p-existing', name: 'Existing Project', directoryId: directory.id, defaultSessionId: 'ses_existing'
    });
    const updated = store.updateDirectory(directory.id, { workspacePath: 'D:\\workspace\\new-root' });
    assert.equal(updated.workspacePath, 'D:\\workspace\\new-root');
    assert.equal(store.getProject(existing.id)!.workspacePath, 'D:\\workspace\\new-root');
    assert.equal(store.getProject(existing.id)!.defaultSessionId, 'ses_existing');
    const project = store.createProject({ id: 'p-b', name: 'Project B', directoryId: directory.id });
    assert.equal(project.workspacePath, 'D:\\workspace\\new-root');
  });

  it('workspace changes preserve Sessions for projects in that Directory only', () => {
    const store = new Store(':memory:', new DatabaseSync(':memory:'));
    const directory = store.createDirectory({ id: 'sync-dir', name: 'Sync directory', workspacePath: '/workspace/old' });
    const otherDirectory = store.createDirectory({ id: 'other-dir', name: 'Other directory', workspacePath: '/other' });
    store.createProject({ id: 'sync-a', name: 'Project A', directoryId: directory.id, defaultSessionId: 'ses-project-a' });
    store.createProject({ id: 'sync-b', name: 'Project B', directoryId: directory.id, defaultSessionId: 'ses-project-b' });
    store.createProject({ id: 'other-project', name: 'Other Project', directoryId: otherDirectory.id, defaultSessionId: 'ses-other' });
    const issue = store.createIssue({ projectId: 'sync-a', title: 'Bound task' });
    const updatedDirectory = store.updateDirectory(directory.id, { workspacePath: '/workspace/new' });
    assert.equal(updatedDirectory.workspacePath, '/workspace/new');
    for (const [id, sessionId] of [['sync-a', 'ses-project-a'], ['sync-b', 'ses-project-b']]) {
      const project = store.getProject(id)!;
      assert.equal(project.workspacePath, '/workspace/new');
      assert.equal(project.defaultSessionId, sessionId);
    }
    assert.equal(store.getIssue(issue.id)?.sessionId, 'ses-project-a');
    assert.ok(!store.listActivities(issue.id).some(activity => activity.action === 'session-unbound'));
    assert.deepEqual(
      [store.getProject('other-project')!.workspacePath, store.getProject('other-project')!.defaultSessionId],
      ['/other', 'ses-other']
    );
  });

  it('legacy project creation reuses a matching Directory by workspace path', () => {
    const store = new Store(':memory:', new DatabaseSync(':memory:'));
    const first = store.createProject({ id: 'legacy-a', name: 'Legacy A', workspacePath: '/workspace/a' });
    const second = store.createProject({ id: 'legacy-b', name: 'Legacy B', workspacePath: '/workspace/a' });
    assert.equal(first.directoryId, second.directoryId);
    assert.equal(store.listDirectories().length, 1);
  });

  it('does not delete a directory while projects still belong to it', () => {
    const store = new Store(':memory:', new DatabaseSync(':memory:'));
    const directory = store.createDirectory({ name: 'Workspace' });
    store.createProject({ id: 'p1', name: 'P1', directoryId: directory.id });
    assert.throws(() => store.deleteDirectory(directory.id), /not empty/);
  });

  it('cascadeProjects removes the directory, its projects, tasks and comments', () => {
    const store = new Store(':memory:', new DatabaseSync(':memory:'));
    const directory = store.createDirectory({ name: 'Workspace' });
    const project = store.createProject({ id: 'p1', name: 'P1', directoryId: directory.id });
    const issue = store.createIssue({ projectId: project.id, title: 'T' });
    store.addComment(issue.id, { author: 'web', body: 'hello' });

    store.deleteDirectory(directory.id, { cascadeProjects: true });

    assert.equal(store.getProject(project.id) ?? null, null);
    assert.equal(store.getIssue(issue.id) ?? null, null);
    assert.equal(store.listComments(issue.id).length, 0);
    assert.equal(store.listDirectories().length, 0);
  });
});

describe('project labels', () => {
  it('create persists labels; default is empty string', () => {
    const { store } = fresh();
    const pa = store.createProject({ id: 'pa', name: 'A', labels: 'roadmap,work' });
    const pb2 = store.createProject({ id: 'pb2', name: 'B' });
    assert.equal(store.getProject(pa.id)!.labels, 'roadmap,work');
    assert.equal(store.getProject(pb2.id)!.labels, '');
  });

  it('updateProject rewrites labels', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const p = store.updateProject('p1', { labels: 'x,y' });
    assert.equal(p.labels, 'x,y');
    assert.equal(store.updateProject('p1', { labels: '' }).labels, '');
  });
});

describe('wake comment reopens settled tasks', () => {
  it('in_review → in_progress on @agent comment; emits issue.updated + activity', () => {
    const { store, events } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const is = store.createIssue({ projectId: 'p1', title: 'T', status: 'in_review' } as never);
    const before = events.filter(e => e.type === 'issue.updated').length;
    store.addComment(is.id, { author: 'user', body: '@agent 再改一下文案' });
    const after = store.getIssue(is.id)!;
    assert.equal(after.status, 'in_progress');
    assert.ok(events.filter(e => e.type === 'issue.updated').length > before);
    const log = store.listActivities(is.id).map(a => a.detail).join(' ');
    assert.match(log, /status: in_review→in_progress/);
  });

  it('done → in_progress likewise; non-wake comments never touch status', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const is = store.createIssue({ projectId: 'p1', title: 'T', status: 'done' } as never);
    store.addComment(is.id, { author: 'user', body: '普通评论，不是唤醒' });
    assert.equal(store.getIssue(is.id)!.status, 'done');
    store.addComment(is.id, { author: 'user', body: '  @agent 修一下' });
    assert.equal(store.getIssue(is.id)!.status, 'in_progress');
  });

  it('re-queueing a NON-wake comment to pending leaves a settled task alone', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const is = store.createIssue({ projectId: 'p1', title: 'T', status: 'in_review' } as never);
    const c = store.addComment(is.id, { author: 'web', body: '普通评论，不是唤醒' });
    assert.equal(store.getIssue(is.id)!.status, 'in_review');
    store.updateComment(c.id, { status: 'pending' }, 'web');
    assert.equal(store.getIssue(is.id)!.status, 'in_review');
  });

  it('re-queueing a WAKE comment to pending still reopens a done task', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const is = store.createIssue({ projectId: 'p1', title: 'T' });
    const c = store.addComment(is.id, { author: 'web', body: '@agent 返工' });
    store.updateComment(c.id, { status: 'processed' }, 'web');
    store.updateIssue(is.id, { status: 'done' });
    assert.equal(store.getIssue(is.id)!.status, 'done');
    store.updateComment(c.id, { status: 'pending' }, 'web');
    assert.equal(store.getIssue(is.id)!.status, 'in_progress');
  });

  it('leaves todo untouched (re-open only applies to settled states); no version bump', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const is = store.createIssue({ projectId: 'p1', title: 'T' });
    const v1 = store.getIssue(is.id)!.version;
    store.addComment(is.id, { author: 'user', body: '@agent still pending, wake matters only upstream' });
    const after = store.getIssue(is.id)!;
    assert.equal(after.status, 'todo');
    assert.equal(after.version, v1);
  });
});

// isWakeComment is the shared predicate: the Store re-opens on it and the
// watch sidecar delivers on it, so both must agree about leading whitespace.
describe('isWakeComment', () => {
  it('matches the prefix at the start and tolerates leading whitespace', () => {
    assert.equal(isWakeComment('@agent 干活'), true);
    assert.equal(isWakeComment('\n  @agent 干活'), true);
    assert.equal(isWakeComment('普通评论'), false);
    assert.equal(isWakeComment('提到 @agent 但不在开头'), false);
    assert.equal(isWakeComment(''), false);
  });

  it('honours a custom prefix (watch --on)', () => {
    assert.equal(isWakeComment('!bot 干活', '!bot'), true);
    assert.equal(isWakeComment('  !bot 干活', '!bot'), true);
    assert.equal(isWakeComment('@agent 干活', '!bot'), false);
  });
});

// --- task execution lifecycle and acceptance metadata ---------------------

describe('task execution lifecycle', () => {
  it('does not record a start time when a task moves directly to review', () => {
    const { store } = fresh();
    store.createProject({ id: 'lifecycle-review-project', name: 'Lifecycle review' });
    const created = store.createIssue({ projectId: 'lifecycle-review-project', title: 'Review without start' });
    const review = store.updateIssue(created.id, { status: 'in_review' }, created.version, 'web');
    assert.equal(review.startedAt, null);
    assert.equal(review.completedAt, null);
  });

  it('records first start/completion and clears completion when reopened', () => {
    const { store } = fresh();
    store.createProject({ id: 'lifecycle-project', name: 'Lifecycle' });
    const created = store.createIssue({ projectId: 'lifecycle-project', title: 'Lifecycle task' });
    assert.equal(created.startedAt, null);
    assert.equal(created.completedAt, null);

    const started = store.updateIssue(created.id, { status: 'in_progress' }, created.version, 'web');
    assert.ok(started.startedAt);
    assert.equal(started.completedAt, null);
    const firstStartedAt = started.startedAt;

    const renamed = store.updateIssue(created.id, { title: 'Still working' }, started.version, 'web');
    assert.equal(renamed.startedAt, firstStartedAt);

    const completed = store.updateIssue(created.id, { status: 'done' }, renamed.version, 'web');
    assert.ok(completed.completedAt);
    assert.equal(completed.startedAt, firstStartedAt);

    const reopened = store.updateIssue(created.id, { status: 'in_progress' }, completed.version, 'web');
    assert.equal(reopened.completedAt, null);
    assert.equal(reopened.startedAt, firstStartedAt);
  });

  it('persists worktree path and acceptance/review fields through the detail model', () => {
    const { store } = fresh();
    store.createProject({ id: 'context-project', name: 'Context' });
    const created = store.createIssue({
      projectId: 'context-project',
      title: 'Context task',
      worktree: 'task-context',
      worktreePath: 'D:\\workspace\\task-context',
      acceptanceCriteria: '- [ ] tests pass',
      reviewStatus: 'changes_requested',
      reviewNotes: 'Add a regression test'
    });
    const loaded = store.getIssue(created.id)!;
    assert.equal(loaded.worktreePath, 'D:\\workspace\\task-context');
    assert.equal(loaded.acceptanceCriteria, '- [ ] tests pass');
    assert.equal(loaded.reviewStatus, 'changes_requested');
    assert.equal(loaded.reviewNotes, 'Add a regression test');
  });
});


describe('agent identity auto-fill (assignee/startDate)', () => {
  it('claim writes assignee and startDate for a todo task', () => {
    const { store } = fresh();
    const project = store.createProject({ id: 'p1', name: 'P' });
    const issue = store.createIssue({ projectId: project.id, title: 'T' });
    assert.equal(issue.assignee, '');
    assert.equal(issue.startDate, null);
    const claimed = store.claimIssue(issue.id, 'sisyphus');
    assert.equal(claimed.status, 'in_progress');
    assert.equal(claimed.assignee, 'sisyphus');
    const today = new Date();
    const expected = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    assert.equal(claimed.startDate, expected);
  });

  it('manual move to in_progress fills startDate once and never overwrites', () => {
    const { store } = fresh();
    const project = store.createProject({ id: 'p1', name: 'P' });
    const issue = store.createIssue({ projectId: project.id, title: 'T', startDate: '2026-01-02' });
    const moved = store.updateIssue(issue.id, { status: 'in_progress' }, undefined, 'sisyphus', '测试流转：开工');
    assert.equal(moved.startDate, '2026-01-02', 'existing startDate must not be overwritten');
    assert.equal(moved.assignee, 'sisyphus', 'agent-driven move updates assignee');
  });

  it('web move to in_progress fills startDate but leaves agent-owned assignee alone', () => {
    const { store } = fresh();
    const project = store.createProject({ id: 'p1', name: 'P' });
    const issue = store.createIssue({ projectId: project.id, title: 'T' });
    const moved = store.updateIssue(issue.id, { status: 'in_progress' }, undefined, 'web');
    assert.ok(moved.startDate, 'web move still stamps the planned start date');
    assert.equal(moved.assignee, '', 'assignee stays agent-owned');
  });
});

describe('wake queue primitives (v22)', () => {
  it('lists pending wake comments FIFO by queued_at and defers not_before items', () => {
    const db = new DatabaseSync(':memory:');
    const store = new Store('.unused', db);
    const project = store.createProject({ id: 'p1', name: 'P' });
    const issueId = store.createIssue({ projectId: project.id, title: 'T' }).id;
    const first = store.addComment(issueId, { author: 'web', body: '@agent first' }).id;
    const second = store.addComment(issueId, { author: 'web', body: '@agent second' }).id;
    // 控制 FIFO：second 的 queued_at 早于 first
    db.prepare("UPDATE comments SET queued_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(second);
    db.prepare("UPDATE comments SET queued_at = '2026-01-02T00:00:00.000Z' WHERE id = ?").run(first);
    const now = '2026-06-01T00:00:00.000Z';
    assert.deepEqual(store.listQueueBatch(now).map(c => c.id), [second, first]);
    // 退避中的评论不进入批次，到期后回到批次
    db.prepare("UPDATE comments SET not_before = '2099-01-01T00:00:00.000Z' WHERE id = ?").run(second);
    assert.deepEqual(store.listQueueBatch(now).map(c => c.id), [first]);
    db.prepare("UPDATE comments SET not_before = '2026-05-01T00:00:00.000Z' WHERE id = ?").run(second);
    assert.deepEqual(store.listQueueBatch(now).map(c => c.id), [second, first]);
  });

  it('requeueWake is CAS-guarded, bumps attempts and records the error', () => {
    const { store } = fresh();
    const project = store.createProject({ id: 'p1', name: 'P' });
    const issueId = store.createIssue({ projectId: project.id, title: 'T' }).id;
    const commentId = store.addComment(issueId, { author: 'web', body: '@agent x' }).id;
    const claim = store.claimWake(commentId, 'watch', 'run-test')!;
    const token = claim.token;
    assert.ok(token, 'claim must succeed for a pending comment');
    // 旧令牌控制不了状态（ABA 防护关键断言）
    assert.equal(store.requeueWake(commentId, 'watch:stale', claim.dispatchId, 'boom', '2099-01-01T00:00:00.000Z'), false);
    assert.equal(store.getComment(commentId)!.status, 'processing');
    // 正确令牌：转回 pending + attempts+1 + 记录错误与下次可投时间。
    assert.equal(store.requeueWake(commentId, token, claim.dispatchId, 'boom', '2099-01-01T00:00:00.000Z'), true);
    const meta = store.queueMeta(commentId)!;
    assert.equal(meta.attempts, 1);
    assert.equal(meta.lastError, 'boom');
    assert.equal(meta.notBefore, '2099-01-01T00:00:00.000Z');
    assert.equal(store.getComment(commentId)!.status, 'pending');
  });
});

describe('wake queue: claim clears stale backoff', () => {
  it('a new claim clears a leftover not_before from an earlier attempt', () => {
    const db = new DatabaseSync(':memory:');
    const store = new Store('.unused', db);
    const project = store.createProject({ id: 'p1', name: 'P' });
    const issueId = store.createIssue({ projectId: project.id, title: 'T' }).id;
    const commentId = store.addComment(issueId, { author: 'web', body: '@agent x' }).id;
    const first = store.claimWake(commentId, 'watch', 'run-test')!;
    assert.ok(first);
    // 失败退避会标记未来 not_before
    assert.equal(store.requeueWake(commentId, first.token, first.dispatchId, 'boom', '2099-01-01T00:00:00.000Z'), true);
    assert.equal(store.queueMeta(commentId)!.notBefore, '2099-01-01T00:00:00.000Z');
    // 退避未到期：任何领取路径都不可绕过（v9 门禁）
    assert.equal(store.claimWake(commentId, 'watch', 'run-test'), null);
    // 退避到期（模拟时间流逝）：claim 清空旧退避，轮询才会自动重试
    db.prepare("UPDATE comments SET not_before = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(commentId);
    const second = store.claimWake(commentId, 'watch', 'run-test')!.token;
    assert.ok(second);
    assert.equal(store.queueMeta(commentId)!.notBefore, null);
  });
});
