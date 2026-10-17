// Comment deletion (v0.4 P0): a comment must be deletable across the stack —
// row gone, FTS index gone, activity trail written, event emitted, and the
// parent issue's optimistic-lock version untouched (comments never bump it).

import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Store, NotFoundError } from '../src/index.js';
import type { StoreEvent } from '../src/index.js';

function fresh(): { store: Store; events: StoreEvent[] } {
  const store = new Store('.unused', new DatabaseSync(':memory:'));
  const events: StoreEvent[] = [];
  store.subscribe(e => events.push(e));
  return { store, events };
}

function seedWithComment() {
  const { store, events } = fresh();
  store.createProject({ id: 'p1', name: 'P' });
  const issue = store.createIssue({ projectId: 'p1', title: 'A' });
  const comment = store.addComment(issue.id, { author: 'alice', body: 'unique-needle-comment' });
  events.length = 0;
  return { store, events, issue, comment };
}

describe('Store.deleteComment', () => {
  it('removes the comment and drops it from full-text search', () => {
    const { store, issue, comment } = seedWithComment();
    assert.equal(store.search('unique-needle').length, 1);

    store.deleteComment(comment.id);

    assert.equal(store.getComment(comment.id), null);
    assert.deepEqual(store.listComments(issue.id), []);
    assert.equal(store.search('unique-needle').length, 0, 'FTS row must go with the comment');
  });

  it('emits comment.deleted (with issueId) and logs a comment-deleted activity', () => {
    const { store, events, issue, comment } = seedWithComment();

    store.deleteComment(comment.id, 'bob');

    const evt = events.find(e => e.type === 'comment.deleted');
    assert.ok(evt, 'comment.deleted event expected');
    assert.equal(evt.payload.id, comment.id);
    assert.equal(evt.payload.issueId, issue.id);
    const act = store.listActivities(issue.id).find(a => a.action === 'comment-deleted');
    assert.ok(act, 'activity expected');
    assert.equal(act.actor, 'bob');
  });

  it('enriches comment events with author, body excerpt and issue title (v0.4 payload)', () => {
    const { store, events, issue } = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const created = store.createIssue({ projectId: 'p1', title: '被评论的任务' });
    events.length = 0;

    const comment = store.addComment(created.id, { author: 'alice', body: 'x'.repeat(500) });
    const addEvt = events.find(e => e.type === 'comment.created')!;
    assert.equal(addEvt.payload.author, 'alice');
    assert.equal(addEvt.payload.body, 'x'.repeat(200), 'body excerpt capped at 200');
    assert.equal(addEvt.payload.issueTitle, '被评论的任务');

    events.length = 0;
    store.deleteComment(comment.id, 'bob');
    const delEvt = events.find(e => e.type === 'comment.deleted')!;
    assert.equal(delEvt.payload.author, 'alice', 'deleted payload carries the original author');
    assert.equal(delEvt.payload.issueTitle, '被评论的任务');
    assert.equal(delEvt.payload.issueId, created.id);
  });

  it('throws NotFoundError on an unknown comment id', () => {
    const { store } = fresh();
    throwsNotFound(() => store.deleteComment('ghost'));
  });

  it('does not bump the issue version (comments never invalidate optimistic locks)', () => {
    const { store, issue } = seedWithComment();
    const before = store.getIssue(issue.id)!;

    store.deleteComment(store.listComments(issue.id)[0]!.id);

    const after = store.getIssue(issue.id)!;
    assert.equal(after.version, before.version);
    assert.ok(after.updatedAt >= before.updatedAt);
  });
});

function throwsNotFound(fn: () => unknown): void {
  let caught: unknown;
  try { fn(); } catch (err) { caught = err; }
  assert.ok(caught instanceof NotFoundError, `expected NotFoundError, got: ${String(caught)}`);
}
