// BrowserAuth session persistence: a server restart must not invalidate
// browser sessions. All scenarios run against a fresh temp dataDir; restart
// is simulated by constructing a second BrowserAuth over the same directory.

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserAuth } from '../src/auth.js';

function newAuthDir(): string {
  return mkdtempSync(join(tmpdir(), 'taskboard-auth-'));
}

async function setupAdmin(dir: string): Promise<{ auth: BrowserAuth; cookie: string }> {
  const auth = new BrowserAuth(dir);
  const { sessionToken } = await auth.initialize('admin', 'long-password-123');
  return { auth, cookie: auth.cookie(sessionToken, false) };
}

describe('browser auth session persistence', () => {
  it('sessions survive a restart', async () => {
    const dir = newAuthDir();
    const { cookie } = await setupAdmin(dir);
    assert.equal(existsSync(join(dir, 'taskboard-sessions.json')), true);

    const restarted = new BrowserAuth(dir);
    assert.equal(restarted.sessionUser(cookie), 'admin');
  });

  it('logout persists across a restart', async () => {
    const dir = newAuthDir();
    const { auth, cookie } = await setupAdmin(dir);
    auth.logout(cookie);

    const restarted = new BrowserAuth(dir);
    assert.equal(restarted.sessionUser(cookie), null);
  });

  it('expired sessions are dropped on load', async () => {
    const dir = newAuthDir();
    await setupAdmin(dir);
    const sessionsFile = join(dir, 'taskboard-sessions.json');
    writeFileSync(sessionsFile, JSON.stringify({
      version: 1,
      sessions: {
        expiredToken: { username: 'admin', expiresAt: Date.now() - 1_000 },
        liveToken: { username: 'admin', expiresAt: Date.now() + 60 * 60 * 1_000 }
      }
    }), 'utf8');

    const restarted = new BrowserAuth(dir);
    assert.equal(restarted.sessionUser('taskboard_session=expiredToken'), null);
    assert.equal(restarted.sessionUser('taskboard_session=liveToken'), 'admin');
  });

  it('a corrupt sessions file starts empty instead of crashing', async () => {
    const dir = newAuthDir();
    const sessionsFile = join(dir, 'taskboard-sessions.json');
    writeFileSync(sessionsFile, '{broken json', 'utf8');

    const auth = new BrowserAuth(dir);
    assert.equal(auth.sessionUser('taskboard_session=whatever'), null);
    // The next login rewrites the file into a valid state.
    const { sessionToken } = await auth.initialize('admin', 'long-password-123');
    const cookie = auth.cookie(sessionToken, false);
    assert.equal(auth.sessionUser(cookie), 'admin');
    const restarted = new BrowserAuth(dir);
    assert.equal(restarted.sessionUser(cookie), 'admin');
  });
});
