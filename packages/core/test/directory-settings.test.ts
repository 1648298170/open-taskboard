// Directories carry the OpenCode Server URL inherited by their projects, and
// global settings expose a default server URL alongside the workspace path.

import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/index.js';
import { configureDatabase, MIGRATIONS } from '../src/db.js';

const fresh = (): Store => new Store('.unused', new DatabaseSync(':memory:'));

describe('workspace directory server URL', () => {
  it('persists on create and update', () => {
    const store = fresh();
    const created = store.createDirectory({ name: 'D', workspacePath: 'D:/ws', serverUrl: 'http://10.0.0.5:4096' });
    assert.equal(created.serverUrl, 'http://10.0.0.5:4096');

    const updated = store.updateDirectory(created.id, { serverUrl: 'http://10.0.0.6:4096' });
    assert.equal(updated.serverUrl, 'http://10.0.0.6:4096');

    const cleared = store.updateDirectory(created.id, { serverUrl: '' });
    assert.equal(cleared.serverUrl, '');
  });

  it('adds directories.server_url in migration v16', () => {
    const db = new DatabaseSync(':memory:');
    configureDatabase(db);
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    assert.equal(version, MIGRATIONS.length);
    assert.ok(MIGRATIONS.length >= 16);
    const cols = db.prepare("SELECT name FROM pragma_table_info('directories')").all() as { name: string }[];
    assert.ok(cols.some(c => c.name === 'server_url'));
  });
});

describe('application settings', () => {
  it('round-trips the default OpenCode server URL', () => {
    const store = fresh();
    const updated = store.updateAppSettings({
      defaultWorkspacePath: 'D:/ws',
      defaultOpenCodeServerUrl: 'http://127.0.0.1:4096'
    });
    assert.equal(updated.defaultWorkspacePath, 'D:/ws');
    assert.equal(updated.defaultOpenCodeServerUrl, 'http://127.0.0.1:4096');
    assert.deepEqual(store.getAppSettings(), {
      defaultWorkspacePath: 'D:/ws',
      defaultOpenCodeServerUrl: 'http://127.0.0.1:4096'
    });
  });

  it('updates only the provided setting', () => {
    const store = fresh();
    store.updateAppSettings({ defaultWorkspacePath: 'D:/ws' });
    const updated = store.updateAppSettings({ defaultOpenCodeServerUrl: 'http://10.0.0.7:4096' });
    assert.equal(updated.defaultWorkspacePath, 'D:/ws');
    assert.equal(updated.defaultOpenCodeServerUrl, 'http://10.0.0.7:4096');
  });
});
