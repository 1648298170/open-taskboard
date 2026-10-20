// Compatibility: master's project-session line and this branch's directory line
// both stamped user_version 13 with different schemas. Opening such a database
// with the unified code must repair it without losing the stored binding.

import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/index.js';
import { configureDatabase, MIGRATIONS } from '../src/db.js';

describe('migration compatibility', () => {
  it('repairs a project-session v13 database (no directories) and preserves session bindings', () => {
    const db = new DatabaseSync(':memory:');
    configureDatabase(db);

    // Seed data in the current shape, then rewind the schema to the divergent
    // master v13 layout: projects.session_id, no directories/app_settings.
    db.prepare(
      "INSERT INTO projects (id, name, workspace_path, wake_channel, labels, created_at) VALUES ('p1', 'P', 'D:/ws', 'http://127.0.0.1:4096', '', '2024-01-01T00:00:00.000Z')"
    ).run();
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec('DROP INDEX IF EXISTS idx_projects_directory;');
    db.exec('ALTER TABLE projects DROP COLUMN directory_id;');
    db.exec('ALTER TABLE projects DROP COLUMN default_session_id;');
    db.exec('ALTER TABLE projects ADD COLUMN session_id TEXT');
    db.exec("UPDATE projects SET session_id = 'ses_old' WHERE id = 'p1'");
    db.exec('DROP TABLE directories;');
    db.exec('DROP TABLE app_settings;');
    db.exec('PRAGMA user_version = 13;');

    const store = new Store('.unused', db);
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    assert.equal(version, MIGRATIONS.length);

    const project = store.getProject('p1');
    assert.ok(project);
    assert.equal(project.defaultSessionId, 'ses_old');
    assert.ok(project.directoryId);

    const directory = db.prepare('SELECT workspace_path AS workspacePath FROM directories WHERE id = ?')
      .get(project.directoryId) as { workspacePath: string };
    assert.equal(directory.workspacePath, 'D:/ws');

    const settings = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'").get();
    assert.ok(settings);
  });

  it('keeps the current v15 database idempotent', () => {
    const db = new DatabaseSync(':memory:');
    configureDatabase(db);
    const first = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    configureDatabase(db);
    const second = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    assert.equal(first, MIGRATIONS.length);
    assert.equal(second, MIGRATIONS.length);
  });
});
