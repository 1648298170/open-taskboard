import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/index.js';

function fresh(): Store {
  return new Store('.unused', new DatabaseSync(':memory:'));
}

describe('project-inherited Session', () => {
  it('reads the Project default Session even when a legacy task input provides another id', () => {
    const store = fresh();
    store.createProject({ id: 'p1', name: 'P', defaultSessionId: 'ses_project' });
    const issue = store.createIssue({ projectId: 'p1', title: 'A', sessionId: 'ses_abc' });
    assert.equal(issue.sessionId, 'ses_project');
    assert.equal(store.getIssue(issue.id)!.sessionId, 'ses_project');
  });

  it('tasks in a project without a default Session remain unbound', () => {
    const store = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const issue = store.createIssue({ projectId: 'p1', title: 'A', sessionId: 'ses_abc' });
    assert.equal(issue.sessionId, null);
  });

  it('ignores task-level Session patches and never changes the Project default', () => {
    const store = fresh();
    store.createProject({ id: 'p1', name: 'P', defaultSessionId: 'ses_project' });
    const issue = store.createIssue({ projectId: 'p1', title: 'A' });

    const unchanged = store.updateIssue(issue.id, { sessionId: 'ses_task' });
    assert.equal(unchanged.sessionId, 'ses_project');
    assert.equal(unchanged.version, 1, 'ignored Session patch does not mutate the task');
    assert.equal(store.getProject('p1')!.defaultSessionId, 'ses_project');
  });

  it('list/search projections return the inherited Session value', () => {
    const store = fresh();
    store.createProject({ id: 'p1', name: 'P', defaultSessionId: 'ses_project' });
    const issue = store.createIssue({ projectId: 'p1', title: 'searchable' });
    const listed = store.listIssues('p1').find(i => i.id === issue.id)!;
    assert.equal(listed.sessionId, 'ses_project');
    const found = store.search('searchable').find(i => i.id === issue.id)!;
    assert.equal(found.sessionId, 'ses_project');
  });

  it('accepts sessionId for transport compatibility but never binds it to the task row', async () => {
    const { createIssueSchema } = await import('../src/schemas.js');
    assert.equal(createIssueSchema.safeParse({ projectId: 'p', title: 't', sessionId: 'ses_x' }).success, true);
    assert.equal(createIssueSchema.safeParse({ projectId: 'p', title: 't', sessionId: null }).success, true);
    assert.equal(createIssueSchema.safeParse({ projectId: 'p', title: 't', sessionId: '' }).success, false);

    const db = new DatabaseSync(':memory:');
    const store = new Store('.unused', db);
    const cols = db.prepare("SELECT name FROM pragma_table_info('issues')").all() as { name: string }[];
    assert.ok(!cols.some(col => col.name === 'session_id'), 'issue table must not duplicate Session ids');
  });
});
