// Project-level default opencode session (migration v13): new issues inherit
// the project's session when the caller supplies none. Precedence:
// explicit body sessionId → agentSessionId → project.sessionId → null.

import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Store, resolveIssueSessionId } from '../src/index.js';
import { configureDatabase, MIGRATIONS } from '../src/db.js';
import { createProjectSchema, projectPatchSchema } from '../src/schemas.js';

function fresh(): Store {
  return new Store('.unused', new DatabaseSync(':memory:'));
}

describe('project session — migration v13', () => {
  it('adds projects.session_id and legacy rows read as unbound', () => {
    const db = new DatabaseSync(':memory:');
    configureDatabase(db);

    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    assert.equal(version, MIGRATIONS.length);
    assert.equal(version, 13);

    const cols = db.prepare("SELECT name FROM pragma_table_info('projects')").all() as { name: string }[];
    assert.ok(cols.some(c => c.name === 'session_id'), 'projects.session_id column must exist');

    // Legacy row written without the column: the NOT NULL DEFAULT '' applies.
    db.prepare(
      "INSERT INTO projects (id, name, workspace_path, created_at) VALUES ('legacy', 'Legacy', '', '2024-01-01T00:00:00.000Z')"
    ).run();

    const store = new Store('.unused', db);
    const legacy = store.getProject('legacy');
    assert.ok(legacy);
    assert.equal(legacy.sessionId, '');
  });
});

describe('project session — create/read', () => {
  it('persists sessionId and returns it from getProject and listProjects', () => {
    const store = fresh();
    const created = store.createProject({ id: 'p1', name: 'P', sessionId: 'ses_proj' });
    assert.equal(created.sessionId, 'ses_proj');

    assert.equal(store.getProject('p1')!.sessionId, 'ses_proj');
    assert.equal(store.listProjects().find(p => p.id === 'p1')!.sessionId, 'ses_proj');
  });

  it('defaults sessionId to the empty string (unbound)', () => {
    const store = fresh();
    const created = store.createProject({ id: 'p1', name: 'P' });
    assert.equal(created.sessionId, '');
  });
});

describe('project session — update', () => {
  it('sets, replaces, and clears sessionId', () => {
    const store = fresh();
    store.createProject({ id: 'p1', name: 'P' });

    const set = store.updateProject('p1', { sessionId: 'ses_1' });
    assert.equal(set.sessionId, 'ses_1');

    const replaced = store.updateProject('p1', { sessionId: 'ses_2' });
    assert.equal(replaced.sessionId, 'ses_2');

    const cleared = store.updateProject('p1', { sessionId: '' });
    assert.equal(cleared.sessionId, '');
    assert.equal(store.getProject('p1')!.name, 'P', 'other fields stay intact');
  });

  it('emits project.updated while keeping the existing transaction semantics', () => {
    const store = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const events: string[] = [];
    store.subscribe(e => events.push(e.type));

    store.updateProject('p1', { sessionId: 'ses_1' });
    assert.deepEqual(events.filter(t => t === 'project.updated'), ['project.updated']);
  });
});

describe('project session — issue inheritance', () => {
  it('defaults to the project session when the body sessionId is undefined', () => {
    const store = fresh();
    store.createProject({ id: 'p1', name: 'P', sessionId: 'ses_proj' });

    const issue = store.createIssue({ projectId: 'p1', title: 'A' });
    assert.equal(issue.sessionId, 'ses_proj');
    assert.equal(store.getIssue(issue.id)!.sessionId, 'ses_proj');
  });

  it('treats explicit null and whitespace as absent and falls through to the project session', () => {
    const store = fresh();
    store.createProject({ id: 'p1', name: 'P', sessionId: 'ses_proj' });

    const nulled = store.createIssue({ projectId: 'p1', title: 'A', sessionId: null });
    assert.equal(nulled.sessionId, 'ses_proj');

    const blank = store.createIssue({ projectId: 'p1', title: 'B', sessionId: '   ' });
    assert.equal(blank.sessionId, 'ses_proj');
  });

  it('prefers the explicit body sessionId over agentSessionId and the project session', () => {
    const store = fresh();
    store.createProject({ id: 'p1', name: 'P', sessionId: 'ses_proj' });

    const issue = store.createIssue({ projectId: 'p1', title: 'A', sessionId: 'ses_body' }, '', 'ses_agent');
    assert.equal(issue.sessionId, 'ses_body');
  });

  it('prefers agentSessionId over the project session', () => {
    const store = fresh();
    store.createProject({ id: 'p1', name: 'P', sessionId: 'ses_proj' });

    const issue = store.createIssue({ projectId: 'p1', title: 'A' }, '', 'ses_agent');
    assert.equal(issue.sessionId, 'ses_agent');
  });

  it('legacy project (empty sessionId) yields null', () => {
    const store = fresh();
    store.createProject({ id: 'p1', name: 'P' });

    const issue = store.createIssue({ projectId: 'p1', title: 'A' });
    assert.equal(issue.sessionId, null);
  });

  it('setting a project session does not retroactively bind existing issues', () => {
    const store = fresh();
    store.createProject({ id: 'p1', name: 'P' });
    const issue = store.createIssue({ projectId: 'p1', title: 'A' });
    assert.equal(issue.sessionId, null);

    store.updateProject('p1', { sessionId: 'ses_later' });
    assert.equal(store.getIssue(issue.id)!.sessionId, null);
  });
});

describe('resolveIssueSessionId', () => {
  it('trims values and returns the first non-empty one', () => {
    assert.equal(resolveIssueSessionId('  ses_body  ', 'ses_agent', 'ses_proj'), 'ses_body');
    assert.equal(resolveIssueSessionId('   ', '  ses_agent ', 'ses_proj'), 'ses_agent');
    assert.equal(resolveIssueSessionId(undefined, null, ' ses_proj '), 'ses_proj');
  });

  it('returns null when nothing is bound', () => {
    assert.equal(resolveIssueSessionId(), null);
    assert.equal(resolveIssueSessionId(null, '', '   '), null);
  });
});

describe('project session — schemas', () => {
  it('create accepts a non-empty trimmed sessionId and rejects whitespace-only', () => {
    assert.equal(createProjectSchema.safeParse({ name: 'P', sessionId: 'ses_x' }).success, true);
    assert.equal(createProjectSchema.safeParse({ name: 'P', sessionId: '  ' }).success, false);
    assert.equal(createProjectSchema.safeParse({ name: 'P' }).success, true);
  });

  it('patch accepts a real sessionId or "" (clear) and rejects whitespace-only', () => {
    assert.equal(projectPatchSchema.safeParse({ sessionId: 'ses_x' }).success, true);
    assert.equal(projectPatchSchema.safeParse({ sessionId: '' }).success, true);
    assert.equal(projectPatchSchema.safeParse({ sessionId: '   ' }).success, false);
  });

  it('both schemas stay strict', () => {
    assert.equal(createProjectSchema.safeParse({ name: 'P', unknown: 1 }).success, false);
    assert.equal(projectPatchSchema.safeParse({ sessionId: '', unknown: 1 }).success, false);
  });
});
