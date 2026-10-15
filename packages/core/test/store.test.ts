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
