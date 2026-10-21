import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/index.js';
import { configureDatabase, MIGRATIONS } from '../src/db.js';
import { createIssueSchema, createProjectSchema, projectPatchSchema } from '../src/schemas.js';

function fresh(): Store { return new Store('.unused', new DatabaseSync(':memory:')); }

describe('project Session inheritance', () => {
  it('drops duplicated project route and task Session columns after migration', () => {
    const db = new DatabaseSync(':memory:');
    configureDatabase(db);
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    assert.equal(version, MIGRATIONS.length);
    assert.ok(MIGRATIONS.length >= 18);
    const projectCols = db.prepare("SELECT name FROM pragma_table_info('projects')").all() as { name: string }[];
    const issueCols = db.prepare("SELECT name FROM pragma_table_info('issues')").all() as { name: string }[];
    assert.ok(!projectCols.some(c => c.name === 'workspace_path'));
    assert.ok(!projectCols.some(c => c.name === 'wake_channel'));
    assert.ok(!issueCols.some(c => c.name === 'session_id'));
  });
  it('returns the project default Session on a newly created task', () => {
    const store = fresh();
    const directory = store.createDirectory({ id: 'd1', name: 'D', workspacePath: '/repo', serverUrl: 'http://127.0.0.1:4096' });
    const project = store.createProject({ id: 'p1', name: 'P', directoryId: directory.id, defaultSessionId: 'ses_project' });
    const issue = store.createIssue({ projectId: project.id, title: 'Task' });
    assert.equal(issue.sessionId, 'ses_project');
    assert.equal(store.getIssue(issue.id)!.sessionId, 'ses_project');
  });
  it('ignores legacy task Session input in favor of the project default', () => {
    const store = fresh();
    const directory = store.createDirectory({ id: 'd1', name: 'D', workspacePath: '/repo', serverUrl: 'http://127.0.0.1:4096' });
    store.createProject({ id: 'p1', name: 'P', directoryId: directory.id, defaultSessionId: 'ses_project' });
    const issue = store.createIssue({ projectId: 'p1', title: 'Task', sessionId: 'ses_override' }, '', 'ses_agent');
    assert.equal(issue.sessionId, 'ses_project');
  });
  it('existing tasks dynamically follow project Session changes and clearing', () => {
    const store = fresh();
    const directory = store.createDirectory({ id: 'd1', name: 'D', workspacePath: '/repo', serverUrl: 'http://127.0.0.1:4096' });
    store.createProject({ id: 'p1', name: 'P', directoryId: directory.id, defaultSessionId: 'ses_first' });
    const issue = store.createIssue({ projectId: 'p1', title: 'Task' });
    assert.equal(issue.sessionId, 'ses_first');
    store.updateProject('p1', { defaultSessionId: 'ses_second' });
    assert.equal(store.getIssue(issue.id)!.sessionId, 'ses_second');
    store.updateProject('p1', { defaultSessionId: null });
    assert.equal(store.getIssue(issue.id)!.sessionId, null);
  });
  it('allows Session configuration on Project but rejects it on Task', () => {
    assert.equal(createProjectSchema.safeParse({ name: 'P', defaultSessionId: 'ses_project' }).success, true);
    assert.equal(projectPatchSchema.safeParse({ defaultSessionId: 'ses_project' }).success, true);
    assert.equal(createIssueSchema.safeParse({ title: 'Task', projectId: 'p1' }).success, true);
    assert.equal(createIssueSchema.safeParse({ title: 'Task', projectId: 'p1', sessionId: 'ses_override' }).success, false);
  });
  it('returns Directory route values on the Project and ignores route overrides', () => {
    const store = fresh();
    const directory = store.createDirectory({ id: 'd1', name: 'D', workspacePath: '/repo', serverUrl: 'http://127.0.0.1:4096' });
    const project = store.createProject({ id: 'p1', name: 'P', directoryId: directory.id, workspacePath: '/ignored', wakeChannel: 'http://invalid' });
    assert.equal(project.workspacePath, '/repo');
    assert.equal(project.wakeChannel, 'http://127.0.0.1:4096');
  });
});