// Phase 2 integration: the server process embeds the wake engine.
//
// These tests exercise the real startServer path (buildApp + listen + embedded
// engine + onClose) over an in-memory Store, with only outbound OpenCode HTTP
// faked. They never touch the host process's env: TASKBOARD_* is injected via
// ServerOptions.env, exactly like app.test.ts.

import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@taskboard/core';
import type { FastifyInstance } from 'fastify';
import {
  resolveWakePollMs,
  WAKE_POLL_DEFAULT_MS,
  WAKE_POLL_MIN_MS,
  type EmbeddedWake,
} from '../src/wake-embedded.js';
import { startServer } from '../src/server.js';

type Env = Record<string, string | undefined>;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.fail('condition was not met before timeout');
}

interface Fixture {
  app: FastifyInstance;
  store: Store;
  wake: EmbeddedWake;
  db: DatabaseSync;
  issueId: string;
  prompts: string[];
  logs: string[];
  cleanup: () => Promise<void>;
}

/**
 * Mirrors app.test.ts's makeApp(), but through startServer so the embedded
 * engine is the real one under test. `seed` runs before the server (and thus
 * before the engine's startup sweep) so a pre-existing pending wake is only
 * observable through the sweep.
 */
async function makeServer(options: {
  env: Env;
  pollMs?: number;
  seed?: (store: Store, issueId: string) => void;
}): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'tb-wake-'));
  const db = new DatabaseSync(':memory:');
  const store = new Store(dir, db);
  store.createProject({ id: 'p1', name: 'P', defaultSessionId: 'ses_1' });
  const issueId = store.createIssue({ projectId: 'p1', title: 'Wake task' }).id;
  options.seed?.(store, issueId);

  const prompts: string[] = [];
  const logs: string[] = [];
  const { app, wake } = await startServer({
    host: '127.0.0.1',
    port: 0,
    dataDir: dir,
    store,
    env: { TASKBOARD_BACKUPS: '0', ...options.env },
    wake: {
      pollMs: options.pollMs,
      log: message => logs.push(message),
      fetchImpl: async input => {
        const url = String(input);
        if (url.includes('/prompt_async')) prompts.push(url);
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    },
  });

  return {
    app,
    store,
    wake,
    db,
    issueId,
    prompts,
    logs,
    cleanup: async () => {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('embedded wake: startup', () => {
  it('starts ON, sweeps a pre-seeded pending wake, and stops on app.close()', async () => {
    let seeded = '';
    const fixture = await makeServer({
      env: { TASKBOARD_OPENCODE_URL: 'http://oc.test' },
      seed: (store, issueId) => {
        seeded = store.addComment(issueId, { author: 'web', body: '@agent 启动补拉' }).id;
      },
    });
    try {
      assert.ok(
        fixture.logs.some(line => /^wake embedded: on \(instance=[0-9a-f]{8}, opencode=http:\/\/oc\.test, service=(url-namespace|svc-[0-9a-z-]+), poll=60000\)$/.test(line)),
        `missing boot line: ${fixture.logs.join(' | ')}`
      );
      assert.equal(fixture.wake.engine?.isRunning(), true);

      // The comment existed before the engine started: only the one-shot
      // startup sweep can claim and deliver it.
      await waitFor(() => fixture.store.getComment(seeded)!.status === 'processing');
      assert.ok(fixture.prompts.some(url => url.includes('/session/ses_1/prompt_async')));
    } finally {
      await fixture.cleanup();
    }
    assert.equal(fixture.wake.engine?.isRunning(), false, 'onClose must stop the embedded engine');
  });
});

describe('embedded wake: poll', () => {
  it('drains a pending wake that no event ever announced', async () => {
    const fixture = await makeServer({
      env: { TASKBOARD_OPENCODE_URL: 'http://oc.test' },
      pollMs: 25,
    });
    try {
      // Bypass Store.addComment so the event subscription cannot see this row:
      // only the periodic pending sweep can deliver it.
      const t = new Date().toISOString();
      fixture.db.prepare(
        'INSERT INTO comments (id, issue_id, author, body, created_at, updated_at, is_wake) VALUES (?, ?, ?, ?, ?, ?, 1)'
      ).run('poll-only', fixture.issueId, 'web', '@agent 轮询补拉', t, t);

      await waitFor(() => fixture.store.getComment('poll-only')!.status === 'processing');
      assert.ok(fixture.prompts.some(url => url.includes('/session/ses_1/prompt_async')));
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('embedded wake: gate', () => {
  it('does not start when TASKBOARD_WAKE_EMBEDDED=0', async () => {
    const fixture = await makeServer({
      env: { TASKBOARD_OPENCODE_URL: 'http://oc.test', TASKBOARD_WAKE_EMBEDDED: '0' },
    });
    try {
      assert.equal(fixture.wake.engine, null);
      assert.ok(fixture.logs.includes('wake embedded: off (TASKBOARD_WAKE_EMBEDDED=0)'));
    } finally {
      await fixture.cleanup();
    }
  });

  it('passes TASKBOARD_OPENCODE_SERVICE_ID into the engine lease namespace and boot line (§5)', async () => {
    const fixture = await makeServer({
      env: { TASKBOARD_OPENCODE_URL: 'http://oc.test', TASKBOARD_OPENCODE_SERVICE_ID: 'svc-custom' },
    });
    try {
      assert.ok(
        fixture.logs.some(line => /^wake embedded: on \(instance=[0-9a-f]{8}, opencode=http:\/\/oc\.test, service=svc-custom, poll=60000\)$/.test(line)),
        `missing service boot line: ${fixture.logs.join(' | ')}`
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('does not start and logs the exact off-line when no OpenCode URL is configured', async () => {
    const fixture = await makeServer({ env: {} });
    try {
      assert.equal(fixture.wake.engine, null);
      assert.ok(fixture.logs.includes('wake embedded: off (no OpenCode URL configured)'));
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('embedded wake: poll interval resolution', () => {
  it('defaults to 60s, clamps low values, and honors valid overrides', () => {
    assert.equal(resolveWakePollMs({}), WAKE_POLL_DEFAULT_MS);
    assert.equal(resolveWakePollMs({ TASKBOARD_WAKE_POLL_MS: 'nope' }), WAKE_POLL_DEFAULT_MS);
    assert.equal(resolveWakePollMs({ TASKBOARD_WAKE_POLL_MS: '-5' }), WAKE_POLL_DEFAULT_MS);
    assert.equal(resolveWakePollMs({ TASKBOARD_WAKE_POLL_MS: '1000' }), WAKE_POLL_MIN_MS);
    assert.equal(resolveWakePollMs({ TASKBOARD_WAKE_POLL_MS: '15000' }), 15_000);
  });
});
