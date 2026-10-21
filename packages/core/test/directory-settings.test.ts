// OpenCode Server URL is deployment configuration; only workspace paths belong to directories/settings.

import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/index.js';
import { configureDatabase, MIGRATIONS } from '../src/db.js';

const fresh = (): Store => new Store('.unused', new DatabaseSync(':memory:'));

describe('workspace directory configuration', () => {
  it('stores workspace metadata without an OpenCode URL field', () => {
    const store = fresh();
    const created = store.createDirectory({ name: 'D', workspacePath: 'D:/ws' });
    assert.equal(created.workspacePath, 'D:/ws');
    assert.equal('serverUrl' in created, false);

    const updated = store.updateDirectory(created.id, { workspacePath: 'D:/ws-2' });
    assert.equal(updated.workspacePath, 'D:/ws-2');
    assert.equal('serverUrl' in updated, false);
  });

  it('clears legacy persisted OpenCode URLs during migration', () => {
    const db = new DatabaseSync(':memory:');
    configureDatabase(db);
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    assert.equal(version, MIGRATIONS.length);
    assert.ok(MIGRATIONS.length >= 20);
    const cols = db.prepare("SELECT name FROM pragma_table_info('directories')").all() as { name: string }[];
    assert.equal(cols.some(c => c.name === 'server_url'), false);
    const settings = db.prepare("SELECT COUNT(*) AS count FROM app_settings WHERE key = 'default_opencode_server_url'").get() as { count: number };
    assert.equal(settings.count, 0);
  });
});

describe('application settings', () => {
  it('persists only the default workspace path', () => {
    const store = fresh();
    const updated = store.updateAppSettings({ defaultWorkspacePath: 'D:/ws' });
    assert.deepEqual(updated, { defaultWorkspacePath: 'D:/ws' });
    assert.deepEqual(store.getAppSettings(), { defaultWorkspacePath: 'D:/ws' });
  });
});
