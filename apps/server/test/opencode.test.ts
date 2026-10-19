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


describe('OpenCode metadata destination guard', () => {
  it('rejects common cloud metadata and link-local destinations', () => {
    for (const url of [
      'http://169.254.169.254',
      'http://169.254.12.34:4096',
      'http://metadata.google.internal',
      'http://100.100.100.200',
      'http://[fd00:ec2::254]'
    ]) {
      assert.throws(
        () => normalizeOpenCodeBase(url),
        /metadata address/
      );
    }
  });

  it('continues to allow a local OpenCode server', () => {
    assert.equal(normalizeOpenCodeBase('http://127.0.0.1:4096'), 'http://127.0.0.1:4096');
  });
});
