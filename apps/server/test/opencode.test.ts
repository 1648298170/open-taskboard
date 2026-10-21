import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { abortOpenCodeSession, filterSessionsByWorkspace, getOpenCodeSessionRuntimeState, isWindowsDriveRoot, normalizeOpenCodeBase, parentDirectoryPath } from '../src/opencode.js';
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


describe('directory browser path navigation', () => {
  it('recognizes Windows drive roots regardless of slash style', () => {
    assert.equal(isWindowsDriveRoot('D:\\'), true);
    assert.equal(isWindowsDriveRoot('C:/'), true);
    assert.equal(isWindowsDriveRoot('D:'), false);
    assert.equal(isWindowsDriveRoot('D:\\JERRY'), false);
  });

  it('returns Windows parents up to the drive root without crossing volumes', () => {
    assert.equal(parentDirectoryPath('D:\\JERRY\\dsh'), 'D:\\JERRY');
    assert.equal(parentDirectoryPath('D:\\JERRY'), 'D:\\');
    assert.equal(parentDirectoryPath('D:\\'), null);
  });

  it('returns POSIX parents up to the filesystem root', () => {
    assert.equal(parentDirectoryPath('/srv/workspaces/app'), '/srv/workspaces');
    assert.equal(parentDirectoryPath('/'), null);
  });
});


describe('OpenCode runtime recovery and cancellation', () => {
  async function startMockOpenCode(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void) {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock OpenCode server has no TCP address');
    return {
      url: `http://127.0.0.1:${address.port}`,
      close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    };
  }

  it('recovers the authoritative busy state for an existing Session', async () => {
    const mock = await startMockOpenCode((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/session/status')) {
        res.end(JSON.stringify({ ses_123: { type: 'busy' } }));
      } else if (req.url?.startsWith('/session/ses_123')) {
        res.end(JSON.stringify({
          id: 'ses_123',
          title: 'Recover task',
          directory: '/workspace',
          time: { updated: 1_800_000_000_000 }
        }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
    try {
      const state = await getOpenCodeSessionRuntimeState(mock.url, '/workspace', 'ses_123');
      assert.equal(state.sessionId, 'ses_123');
      assert.equal(state.title, 'Recover task');
      assert.equal(state.directory, '/workspace');
      assert.equal(state.status?.type, 'busy');
      assert.equal(state.busy, true);
    } finally {
      await mock.close();
    }
  });

  it('sends a real POST to the owning Session abort endpoint', async () => {
    let abortCalled = false;
    const mock = await startMockOpenCode((req, res) => {
      if (req.method === 'POST' && req.url?.startsWith('/session/ses_123/abort')) {
        abortCalled = true;
        res.statusCode = 204;
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    try {
      await abortOpenCodeSession(mock.url, '/workspace', 'ses_123');
      assert.equal(abortCalled, true);
    } finally {
      await mock.close();
    }
  });
});
