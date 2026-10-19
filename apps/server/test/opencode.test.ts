import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOpenCodeBase } from '../src/opencode.js';

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
