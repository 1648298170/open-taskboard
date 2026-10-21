// Task Sessions are inherited from the owning project's default Session.
// Individual task rows and APIs cannot bind, rebind, or clear Session values.

import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/index.js';
import { createIssueSchema } from '../src/schemas.js';

function fresh(): Store { return new Store('.unused', new DatabaseSync(':memory:')); }

function projectWithSession(store: Store, sessionId: string | null = 'ses_project'): void {
  const directory = store.createDirectory({
    id: 'd1', name: 'D', workspacePath: 'D:/ws', serverUrl: 'http://127.0.0.1:4096'
  });
  store.createProject({ id: 'p1', name: 'P', directoryId: directory.id, defaultSessionId: sessionId });
}

describe('inherited task Session', () => {
  it('projects the owning project default Session onto each task', () => {
    const store = fresh();
    projectWithSession(store);
    const issue = store.createIssue({ projectId: 'p1', title: 'A' });
    assert.equal(issue.sessionId, 'ses_project');
    assert.equal(store.getIssue(issue.id)!.sessionId, 'ses_project');
  });

  it('does not persist legacy task Session inputs', () => {
    const store = fresh();
    projectWithSession(store);
    const issue = store.createIssue({ projectId: 'p1', title: 'A', sessionId: 'ses_override' });
    assert.equal(issue.sessionId, 'ses_project');
  });

  it('updates existing task projections when the project default changes or clears', () => {
    const store = fresh();
    projectWithSession(store);
    const issue = store.createIssue({ projectId: 'p1', title: 'A' });
    store.updateProject('p1', { defaultSessionId: 'ses_next' });
    assert.equal(store.getIssue(issue.id)!.sessionId, 'ses_next');
    store.updateProject('p1', { defaultSessionId: null });
    assert.equal(store.getIssue(issue.id)!.sessionId, null);
  });

  it('includes the inherited Session in list and search projections', () => {
    const store = fresh();
    projectWithSession(store, 'ses_list');
    const issue = store.createIssue({ projectId: 'p1', title: 'searchable' });
    assert.equal(store.listIssues('p1').find(item => item.id === issue.id)?.sessionId, 'ses_list');
    assert.equal(store.search('searchable').find(item => item.id === issue.id)?.sessionId, 'ses_list');
  });

  it('rejects task-level Session input in the public create schema', () => {
    assert.equal(createIssueSchema.safeParse({ projectId: 'p1', title: 't' }).success, true);
    assert.equal(createIssueSchema.safeParse({ projectId: 'p1', title: 't', sessionId: 'ses_override' }).success, false);
    assert.equal(createIssueSchema.safeParse({ projectId: 'p1', title: 't', sessionId: null }).success, false);
  });
});