// Regression tests for the round-4 audit fixes.
//
// Same discipline as store.test.ts: runs against SOURCE via tsx, per-test
// in-memory fixtures (DatabaseSync DI seam), no file IO, no shared state.
// Each describe block pins one audit finding:
//   1. re-parent guard      — moving a parent with children created depth-3
//   2. archive cascade      — archived parent stranded visible children
//   3. claim CAS            — claim could steal a just-renewed lease
//   4. migration atomicity  — a failed migration left DDL behind (bricked replay)
//   5. search LIKE fallback — results missing claimedBy/leaseExpiresAt
//   6. comment ordering     — same-millisecond tie-break pin
//   7. create schema        — confirm escape hatch + real calendar dates

import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Store, ValidationError } from '../src/index.js';
import type { StoreEvent } from '../src/index.js';
import { createIssueSchema } from '../src/schemas.js';
import { configureDatabase, MIGRATIONS, runMigrations } from '../src/db.js';
import { IssueRepo } from '../src/repos/issues.js';
import { ProjectRepo } from '../src/repos/projects.js';
import { CommentRepo } from '../src/repos/comments.js';

// --- helpers ---------------------------------------------------------------

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

function fresh(): { store: Store; events: StoreEvent[] } {
  const store = new Store('.unused', new DatabaseSync(':memory:'));
  const events: StoreEvent[] = [];
  store.subscribe(e => events.push(e));
  return { store, events };
}

const idsFor = (events: StoreEvent[], type: string): unknown[] =>
  events.filter(e => e.type === type).map(e => e.payload.id);

// --- 1. re-parent guard ------------------------------------------------------

describe('re-parent guard (three-level nesting hole)', () => {
  it('rejects moving a parent that has children under another parent', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const A = store.createIssue({ projectId: 'p1', title: 'A' }).id;
    const C = store.createIssue({ projectId: 'p1', title: 'C' }).id;
    store.createIssue({ projectId: 'p1', parentId: A, title: 'B' });
    throwsWith(() => store.updateIssue(A, { parentId: C }), ValidationError,
      /cannot re-parent an issue that has children/);
  });

  it('still allows promoting a child to top level and re-parenting a childless issue', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const A = store.createIssue({ projectId: 'p1', title: 'A' }).id;
    const B = store.createIssue({ projectId: 'p1', parentId: A, title: 'B' }).id;
    const C = store.createIssue({ projectId: 'p1', title: 'C' }).id;
    const promoted = store.updateIssue(B, { parentId: null });
    assert.equal(promoted.parentId, null);
    const moved = store.updateIssue(C, { parentId: A });
    assert.equal(moved.parentId, A);
  });
});

// --- 2. archive cascade + idempotency ----------------------------------------

describe('archive cascade (archived parent stranded visible children)', () => {
  it('archives non-archived children along with the parent (version bump + event each)', () => {
    const { store, events } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const A = store.createIssue({ projectId: 'p1', title: 'A' }).id;
    const B = store.createIssue({ projectId: 'p1', parentId: A, title: 'B' }).id;

    const parent = store.archiveIssue(A);
    const child = store.getIssue(B)!;

    assert.ok(parent.archivedAt);
    assert.ok(child.archivedAt, 'child must be archived along with the parent');
    assert.equal(child.version, 2, 'child archive must bump the child version');
    assert.deepEqual(
      [...idsFor(events, 'issue.updated')].sort(),
      [A, B].sort(),
      'parent and child must each emit issue.updated'
    );
  });

  it('archiving an already-archived issue is a no-op (no bump, no event)', () => {
    const { store, events } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const A = store.createIssue({ projectId: 'p1', title: 'A' }).id;
    store.archiveIssue(A);
    const before = store.getIssue(A)!;
    events.length = 0;

    const again = store.archiveIssue(A);

    assert.equal(again.version, before.version);
    assert.deepEqual(again, before);
    assert.equal(events.filter(e => e.type === 'issue.updated').length, 0);
  });

  it('unarchiving a non-archived issue is a no-op (no bump, no event)', () => {
    const { store, events } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const A = store.createIssue({ projectId: 'p1', title: 'A' }).id;
    const before = store.getIssue(A)!;

    const result = store.unarchiveIssue(A);

    assert.equal(result.version, before.version);
    assert.deepEqual(result, before);
    assert.equal(events.filter(e => e.type === 'issue.updated').length, 0);
  });

  it('unarchive stays single-row: manually archived children stay archived', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const A = store.createIssue({ projectId: 'p1', title: 'A' }).id;
    const B = store.createIssue({ projectId: 'p1', parentId: A, title: 'B' }).id;
    store.archiveIssue(B);
    store.archiveIssue(A);
    store.unarchiveIssue(A);
    assert.equal(store.getIssue(A)!.archivedAt, null);
    assert.ok(store.getIssue(B)!.archivedAt, 'unarchive must not resurrect children');
  });
});

// --- 3. claim CAS vs lease renewal -------------------------------------------

describe('claim CAS vs lease renewal (claim could steal a just-renewed lease)', () => {
  it('setClaim refuses when the observed holder renewed after observation', () => {
    const db = new DatabaseSync(':memory:');
    configureDatabase(db);
    new ProjectRepo(db).create({ id: 'p1', name: 'P' });
    const issues = new IssueRepo(db);
    const id = issues.create({ projectId: 'p1', parentId: null, title: 'x' });

    const t = new Date().toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();

    // a1 claims with an (artificially) expired lease.
    assert.equal(issues.setClaim(id, 'a1', t, past, ''), true);
    // b2 observes the expired lease as free — meanwhile a1 heartbeats/renews:
    assert.equal(issues.extendLease(id, future, 'a1'), true);
    // b2's stale CAS must NOT steal the renewed active lease:
    assert.equal(issues.setClaim(id, 'b2', t, future, 'a1'), false);
    // a1 re-claiming its own active lease still renews (re-entrant):
    const future2 = new Date(Date.now() + 120_000).toISOString();
    assert.equal(issues.setClaim(id, 'a1', t, future2, 'a1'), true);
    // once the lease is expired again, takeover is fair game:
    assert.equal(issues.extendLease(id, past, 'a1'), true);
    assert.equal(issues.setClaim(id, 'b2', t, future, 'a1'), true);
  });
});

// --- 4. migration atomicity ---------------------------------------------------

describe('migration atomicity (failed migration left DDL behind)', () => {
  it('rolls back DDL and user_version when a migration fails midway', () => {
    const db = new DatabaseSync(':memory:');
    configureDatabase(db); // fresh db at the latest version
    const versionBefore = MIGRATIONS.length;

    MIGRATIONS.push(mdb => {
      mdb.exec('CREATE TABLE audit_tmp_marker (a TEXT)');
      throw new Error('boom');
    });
    try {
      assert.throws(() => runMigrations(db), /boom/);
      const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
      assert.equal(version, versionBefore, 'failed migration must not advance user_version');
      const marker = db.prepare("SELECT name FROM sqlite_master WHERE name = 'audit_tmp_marker'").get();
      assert.equal(marker, undefined, 'failed migration DDL must roll back');
    } finally {
      MIGRATIONS.pop();
    }
  });
});

// --- 5. search LIKE fallback shape ---------------------------------------------

describe('search LIKE fallback (results missing claim columns)', () => {
  it('returns claimedBy/leaseExpiresAt on short-query (<3 chars) results', () => {
    const { store } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const id = store.createIssue({ projectId: 'p1', title: 'abcd' }).id;
    store.claimIssue(id, 'agent1', 30);

    const hits = store.search('ab'); // <3 chars → LIKE scan path

    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.claimedBy, 'agent1');
    assert.ok(hits[0]!.leaseExpiresAt);
  });
});

// --- 6. comment ordering tie-break (pin) ----------------------------------------

describe('comment ordering (same-millisecond tie-break)', () => {
  it('lists identical-timestamp comments in insertion order', () => {
    const db = new DatabaseSync(':memory:');
    configureDatabase(db);
    new ProjectRepo(db).create({ id: 'p1', name: 'P' });
    const issues = new IssueRepo(db);
    const id = issues.create({ projectId: 'p1', parentId: null, title: 'x' });

    const comments = new CommentRepo(db);
    const a = comments.add(id, { author: 'a', body: 'first' });
    const b = comments.add(id, { author: 'b', body: 'second' });
    // Force the hazard: both rows share one timestamp.
    db.prepare('UPDATE comments SET created_at = ?').run('2026-01-01T00:00:00.000Z');

    assert.deepEqual(comments.list(id).map(c => c.id), [a, b]);
  });
});

// --- 7. create schema: confirm escape hatch + real dates -------------------------

describe('createIssueSchema (create-path confirm + calendar validation)', () => {
  it('accepts confirm alongside status done (HUMAN_DONE escape hatch)', () => {
    const parsed = createIssueSchema.safeParse({ projectId: 'p', title: 't', status: 'done', confirm: true });
    assert.equal(parsed.success, true);
  });

  it('rejects impossible calendar dates in startDate/dueDate', () => {
    const bad = createIssueSchema.safeParse({ projectId: 'p', title: 't', startDate: '2024-02-31' });
    assert.equal(bad.success, false);
    const badDue = createIssueSchema.safeParse({ projectId: 'p', title: 't', dueDate: '9999-99-99' });
    assert.equal(badDue.success, false);
    const leap = createIssueSchema.safeParse({ projectId: 'p', title: 't', startDate: '2024-02-29' });
    assert.equal(leap.success, true);
  });
});
