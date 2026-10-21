// Compatibility for databases that still contain duplicate project routes and task Sessions.
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/index.js';
import { configureDatabase, MIGRATIONS } from '../src/db.js';

describe('migration compatibility', () => {
  it('moves legacy route and task Session values before dropping duplicate columns', () => {
    const db = new DatabaseSync(':memory:');
    configureDatabase(db);
    const store = new Store('.unused', db);
    const directory = store.createDirectory({ id: 'd1', name: 'D', workspacePath: '', serverUrl: '' });
    store.createProject({ id: 'p1', name: 'P', directoryId: directory.id });
    const issue = store.createIssue({ projectId: 'p1', title: 'Legacy task' });

    // Reintroduce the previous v17 columns to model a production database before migration.
    db.exec("ALTER TABLE projects ADD COLUMN workspace_path TEXT NOT NULL DEFAULT ''");
    db.exec("ALTER TABLE projects ADD COLUMN wake_channel TEXT NOT NULL DEFAULT ''");
    db.exec('ALTER TABLE issues ADD COLUMN session_id TEXT');
    db.prepare('UPDATE projects SET workspace_path = ?, wake_channel = ? WHERE id = ?')
      .run('D:/ws', 'http://127.0.0.1:4096', 'p1');
    db.prepare('UPDATE issues SET session_id = ? WHERE id = ?').run('ses_legacy', issue.id);
    db.exec('PRAGMA user_version = 17;');

    // The next Store startup applies the v17 -> v18 schema migration.
    const reopened = new Store('.unused', db);
    const project = reopened.getProject('p1');
    assert.ok(project);
    assert.equal(project.defaultSessionId, 'ses_legacy');
    assert.equal(project.workspacePath, 'D:/ws');
    assert.equal(project.wakeChannel, 'http://127.0.0.1:4096');
    assert.equal(reopened.getIssue(issue.id)?.sessionId, 'ses_legacy');

    const projectCols = db.prepare("SELECT name FROM pragma_table_info('projects')").all() as { name: string }[];
    const issueCols = db.prepare("SELECT name FROM pragma_table_info('issues')").all() as { name: string }[];
    assert.ok(!projectCols.some(c => c.name === 'workspace_path'));
    assert.ok(!projectCols.some(c => c.name === 'wake_channel'));
    assert.ok(!issueCols.some(c => c.name === 'session_id'));
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, MIGRATIONS.length);
  });

  it('keeps the current schema idempotent', () => {
    const db = new DatabaseSync(':memory:');
    configureDatabase(db);
    const first = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    configureDatabase(db);
    const second = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    assert.equal(first, MIGRATIONS.length);
    assert.equal(second, MIGRATIONS.length);
  });
});