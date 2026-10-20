import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { filterSessionsByWorkspace, normalizeOpenCodeBase } from '../src/opencode.js';
import type { OpenCodeSessionOption } from '../src/opencode.js';

describe('normalizeOpenCodeBase', () => {
  it('accepts an HTTP origin with a port', () => {
    assert.equal(normalizeOpenCodeBase('http://127.0.0.1:4096'), 'http://127.0.0.1:4096');
    assert.equal(normalizeOpenCodeBase('https://opencode.example.com/'), 'https://opencode.example.com');
  });

  it('rejects paths, credentials, query strings, and unsupported protocols', () => {
    for (const url of [
      'http://127.0.0.1:4096/api',
      'http://user:pass@127.0.0.1:4096',
      'http://127.0.0.1:4096?token=x',
      'file:///tmp/opencode'
    ]) {
      assert.throws(() => normalizeOpenCodeBase(url));
    }
  });
});

describe('filterSessionsByWorkspace', () => {
  const session = (id: string, directory: string): OpenCodeSessionOption => ({ id, title: id, directory, updatedAt: null });

  it('returns every session when the workspace path is empty', () => {
    const sessions = [session('a', '/one'), session('b', '/two')];
    assert.deepEqual(filterSessionsByWorkspace(sessions, ''), sessions);
    assert.deepEqual(filterSessionsByWorkspace(sessions, '   '), sessions);
  });

  it('matches normalized directories and drops sessions without a directory', () => {
    const workspace = process.cwd();
    const trailing = `${workspace}${process.platform === 'win32' ? '\\' : '/'}`;
    const sessions = [
      session('match', workspace),
      session('trailing', trailing),
      session('other', join(workspace, 'other')),
      session('none', '')
    ];
    const ids = filterSessionsByWorkspace(sessions, workspace).map(s => s.id);
    assert.deepEqual(ids, ['match', 'trailing']);
  });

  it('is case-insensitive on win32 only', () => {
    const workspace = process.cwd();
    const sessions = [session('upper', workspace.toUpperCase())];
    const ids = filterSessionsByWorkspace(sessions, workspace).map(s => s.id);
    if (process.platform === 'win32') assert.deepEqual(ids, ['upper']);
    else assert.deepEqual(ids, []);
  });
});
