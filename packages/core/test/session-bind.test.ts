// v0.4: session binding — issues may carry the opencode session they were
// split from, so @agent wakes continue the same conversation context.

import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/index.js';

function fresh(): Store {
  return new Store('.unused', new DatabaseSync(':memory:'));
}

describe('session binding (migration v9)', () => {
  it('creates an issue with a bound sessionId and reads it back', () => {
    const store = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const issue = store.createIssue({ projectId: 'p1', title: 'A', sessionId: 'ses_abc' });
    assert.equal(issue.sessionId, 'ses_abc');
    assert.equal(store.getIssue(issue.id)!.sessionId, 'ses_abc');
  });

  it('defaults sessionId to null (CLI/MCP created tasks stay unbound)', () => {
    const store = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const issue = store.createIssue({ projectId: 'p1', title: 'A' });
    assert.equal(issue.sessionId, null);
  });

  it('patches sessionId: bind, rebind, and clear to null', () => {
    const store = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const issue = store.createIssue({ projectId: 'p1', title: 'A' });

    const bound = store.updateIssue(issue.id, { sessionId: 'ses_1' });
    assert.equal(bound.sessionId, 'ses_1');
    assert.equal(bound.version, 2);

    const rebound = store.updateIssue(issue.id, { sessionId: 'ses_2' });
    assert.equal(rebound.sessionId, 'ses_2');

    const cleared = store.updateIssue(issue.id, { sessionId: null });
    assert.equal(cleared.sessionId, null);
  });

  it('list/search projections carry sessionId too', () => {
    const store = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const issue = store.createIssue({ projectId: 'p1', title: 'searchable', sessionId: 'ses_9' });
    const listed = store.listIssues('p1').find(i => i.id === issue.id)!;
    assert.equal(listed.sessionId, 'ses_9', 'list projection must include sessionId');
    const found = store.search('searchable').find(i => i.id === issue.id)!;
    assert.equal(found.sessionId, 'ses_9', 'search projection must include sessionId');
  });

  it('createIssueSchema accepts sessionId (string or null)', async () => {
    const { createIssueSchema } = await import('../src/schemas.js');
    assert.equal(createIssueSchema.safeParse({ projectId: 'p', title: 't', sessionId: 'ses_x' }).success, true);
    assert.equal(createIssueSchema.safeParse({ projectId: 'p', title: 't', sessionId: null }).success, true);
    assert.equal(createIssueSchema.safeParse({ projectId: 'p', title: 't', sessionId: '' }).success, false);
  });
});
