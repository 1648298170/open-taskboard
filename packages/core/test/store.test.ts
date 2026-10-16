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
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Store, NotFoundError, ConflictError, ValidationError } from '../src/index.js';
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
  it('sets user_version to 6 on a fresh store (base schema + all migrations)', () => {
    const db = new DatabaseSync(':memory:');
    new Store('.unused', db); // configureDatabase runs schema + migrations
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(row.user_version, 6);
  });

  it('is idempotent: re-configuring an already-migrated db is a no-op', () => {
    const db = new DatabaseSync(':memory:');
    const store = new Store('.unused', db);
    store.createProject({ id: 'p1', name: 'P' });
    const issue = store.createIssue({ projectId: 'p1', title: 'survives' });
    // Second Store over the same db replays configureDatabase (idempotent path).
    new Store('.unused', db);
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(row.user_version, 6);
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
    store.updateIssue(id, { status: 'in_progress', title: 'tracked v2' }, undefined, 'bob');
    store.addComment(id, { body: 'ship it' }, 'carol');

    // newest first: commented, updated, created
    const acts = store.listActivities(id);
    assert.equal(acts.length, 3);
    assert.deepEqual(acts.map(a => a.action), ['commented', 'updated', 'created']);
    assert.deepEqual(acts.map(a => a.actor), ['carol', 'bob', 'alice']);
    assert.equal(acts[0]!.detail, 'ship it');
    assert.equal(acts[0]!.issueId, id);
    // changed keys joined by ',' (colMap order); status spells out its transition
    assert.equal(acts[1]!.detail, 'title,status: todo→in_progress');
    assert.equal(acts[2]!.detail, 'tracked');
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

// --- (q) backup (T6-32) ----------------------------------------------------------------

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
