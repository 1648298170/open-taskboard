// Project-level default OpenCode sessions (server layer):
// Every issue inherits project.defaultSessionId. Legacy task body/header Session values cannot override it.

import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { FALLBACK_OPENCODE_URL } from '../src/opencode.js';
import type { FastifyInstance } from 'fastify';

type Env = Record<string, string | undefined>;

const OPENCODE_ENV = 'TASKBOARD_OPENCODE_URL';
const json = { 'content-type': 'application/json' };
const originalFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = originalFetch; });

async function withOpenCodeEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env[OPENCODE_ENV];
  if (value === undefined) delete process.env[OPENCODE_ENV];
  else process.env[OPENCODE_ENV] = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[OPENCODE_ENV];
    else process.env[OPENCODE_ENV] = previous;
  }
}

interface App {
  app: FastifyInstance;
  cleanup: () => void;
}

async function makeApp(env: Env = {}): Promise<App> {
  const dir = mkdtempSync(join(tmpdir(), 'tb-session-test-'));
  const store = new (await import('@taskboard/core')).Store(dir, new DatabaseSync(':memory:'));
  const { app } = await buildApp({ store, env });
  return {
    app,
    cleanup: () => { app.close(); rmSync(dir, { recursive: true, force: true }); }
  };
}

type Session = { id: string; title: string; directory: string };

function stubSessions(sessions: Session[], requests?: string[]): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests?.push(String(input));
    return new Response(JSON.stringify(sessions.map(s => ({ ...s, time: { updated: 1 } }))), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;
}

async function postProject(app: FastifyInstance, payload: Record<string, unknown>, actor?: string) {
  return app.inject({
    method: 'POST', url: '/api/projects',
    headers: actor ? { ...json, 'x-taskboard-actor': actor } : json,
    payload
  });
}

async function createProject(app: FastifyInstance, payload: Record<string, unknown>, actor?: string): Promise<FastifyInstance> {
  const res = await postProject(app, payload, actor);
  assert.equal(res.statusCode, 201, res.body);
  return app;
}

async function createIssue(
  app: FastifyInstance, projectId: string, payload: Record<string, unknown>, headers: Record<string, string>
): Promise<{ statusCode: number; body: { sessionId?: string | null; error?: string } }> {
  const res = await app.inject({
    method: 'POST', url: `/api/projects/${projectId}/issues`,
    headers: { ...json, ...headers }, payload
  });
  return { statusCode: res.statusCode, body: res.json() };
}

describe('project creation with a default Session', () => {
  it('web create without a Session is rejected', async () => {
    const { app, cleanup } = await makeApp();
    const res = await postProject(app, { id: 'no-session', name: 'P' }, 'web');
    assert.equal(res.statusCode, 400);
    assert.match(res.json<{ error: string }>().error, /OpenCode Session/);
    cleanup();
  });

  it('web create resolves the Directory workspace and server when only a Session is supplied', async () => {
    await withOpenCodeEnv(undefined, async () => {
      const { app, cleanup } = await makeApp();
      stubSessions([{ id: 'ses_x', title: 'X', directory: 'D:/ws' }]);
      const res = await postProject(app, { id: 'p1', name: 'P', defaultSessionId: 'ses_x' }, 'web');
      assert.equal(res.statusCode, 201, res.body);
      const project = res.json<{ defaultSessionId: string; workspacePath: string; wakeChannel: string }>();
      assert.equal(project.defaultSessionId, 'ses_x');
      assert.equal(project.workspacePath, 'D:/ws');
      assert.equal(project.wakeChannel, FALLBACK_OPENCODE_URL);
      cleanup();
    });
  });

  it('non-web create without Session or server is still allowed', async () => {
    const { app, cleanup } = await makeApp();
    const res = await postProject(app, { id: 'p1', name: 'P' });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json<{ defaultSessionId: string | null }>().defaultSessionId, null);
    cleanup();
  });

  it('uses TASKBOARD_OPENCODE_URL when the server is omitted', async () => {
    await withOpenCodeEnv('http://127.0.0.1:4096', async () => {
      const { app, cleanup } = await makeApp();
      stubSessions([{ id: 'ses_x', title: 'X', directory: 'D:/ws' }]);
      const res = await postProject(app, { id: 'p1', name: 'P', defaultSessionId: 'ses_x' }, 'web');
      assert.equal(res.statusCode, 201, res.body);
      assert.equal(res.json<{ wakeChannel: string }>().wakeChannel, 'http://127.0.0.1:4096');
      cleanup();
    });
  });

  it('rejects a Session whose directory differs from the Directory workspace', async () => {
    const { app, cleanup } = await makeApp();
    stubSessions([{ id: 'ses_x', title: 'X', directory: 'D:/other' }]);
    const res = await postProject(
      app,
      { id: 'p1', name: 'P', defaultSessionId: 'ses_x', workspacePath: 'D:/ws', wakeChannel: 'http://127.0.0.1:4096' },
      'web'
    );
    assert.equal(res.statusCode, 400);
    cleanup();
  });
});

describe('issue creation inherits the project default session', () => {
  it('defaults to the project Session when the body omits it', async () => {
    const { app, cleanup } = await makeApp();
    stubSessions([{ id: 'ses_project', title: 'P', directory: 'D:/ws' }]);
    await createProject(app, { id: 'p1', name: 'P', defaultSessionId: 'ses_project' }, 'web');
    const res = await createIssue(app, 'p1', { title: 'A' }, { 'x-taskboard-actor': 'cli' });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(res.body.sessionId, 'ses_project');
    cleanup();
  });

  it('ignores the x-taskboard-session header when a Project default exists', async () => {
    const { app, cleanup } = await makeApp();
    stubSessions([{ id: 'ses_project', title: 'P', directory: 'D:/ws' }]);
    await createProject(app, { id: 'p1', name: 'P', defaultSessionId: 'ses_project' }, 'web');
    const res = await createIssue(app, 'p1', { title: 'A' }, {
      'x-taskboard-actor': 'cli', 'x-taskboard-session': 'ses_agent'
    });
    assert.equal(res.body.sessionId, 'ses_project');
    cleanup();
  });

  it('ignores explicit body sessionId and inherits the Project default', async () => {
    const { app, cleanup } = await makeApp();
    stubSessions([{ id: 'ses_project', title: 'P', directory: 'D:/ws' }]);
    await createProject(app, { id: 'p1', name: 'P', defaultSessionId: 'ses_project' }, 'web');
    const res = await createIssue(app, 'p1', { title: 'A', sessionId: 'ses_body' }, {
      'x-taskboard-actor': 'cli', 'x-taskboard-session': 'ses_agent'
    });
    assert.equal(res.body.sessionId, 'ses_project');
    cleanup();
  });

  it('agent create in a legacy project stays unbound', async () => {
    const { app, cleanup } = await makeApp();
    await createProject(app, { id: 'p1', name: 'P' });
    const res = await createIssue(app, 'p1', { title: 'A' }, { 'x-taskboard-actor': 'cli' });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.sessionId, null);
    cleanup();
  });
});

describe('PATCH project default Session', () => {
  it('sets and clears defaultSessionId', async () => {
    const { app, cleanup } = await makeApp();
    await createProject(app, {
      id: 'p1', name: 'P', workspacePath: 'D:/ws', wakeChannel: 'http://127.0.0.1:4096'
    });
    stubSessions([{ id: 'ses_default', title: 'D', directory: 'D:/ws' }]);
    const set = await app.inject({
      method: 'PATCH', url: '/api/projects/p1', headers: json, payload: { defaultSessionId: 'ses_default' }
    });
    assert.equal(set.statusCode, 200, set.body);
    assert.equal(set.json<{ defaultSessionId: string }>().defaultSessionId, 'ses_default');

    const clear = await app.inject({
      method: 'PATCH', url: '/api/projects/p1', headers: json, payload: { defaultSessionId: null }
    });
    assert.equal(clear.statusCode, 200);
    assert.equal(clear.json<{ defaultSessionId: string | null }>().defaultSessionId, null);
    cleanup();
  });
});

describe('GET /api/opencode/sessions', () => {
  it('rejects a non-http(s) explicit url', async () => {
    const { app, cleanup } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/opencode/sessions?url=file:///tmp/opencode' });
    assert.equal(res.statusCode, 400);
    assert.match(res.json<{ error: string }>().error, /^url:/);
    cleanup();
  });

  it('resolves a blank url from TASKBOARD_OPENCODE_URL', async () => {
    await withOpenCodeEnv('http://127.0.0.1:4096', async () => {
      const { app, cleanup } = await makeApp();
      const requested: string[] = [];
      stubSessions([{ id: 'ses_a', title: 'A', directory: 'D:/ws' }], requested);
      const res = await app.inject({ method: 'GET', url: '/api/opencode/sessions' });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json<{ serverUrl: string }>().serverUrl, 'http://127.0.0.1:4096');
      assert.ok(requested[0]?.startsWith('http://127.0.0.1:4096/session'));
      cleanup();
    });
  });

  it('an explicit url overrides environment and Directory route defaults', async () => {
    await withOpenCodeEnv('http://10.0.0.9:4096', async () => {
      const { app, cleanup } = await makeApp();
      await createProject(app, { id: 'p1', name: 'P', wakeChannel: 'http://10.0.0.2:4096' });
      const requested: string[] = [];
      stubSessions([{ id: 'ses_a', title: 'A', directory: 'D:/ws' }], requested);
      const explicit = 'http://127.0.0.1:4999';
      const res = await app.inject({
        method: 'GET', url: `/api/opencode/sessions?url=${encodeURIComponent(explicit)}`
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json<{ serverUrl: string }>().serverUrl, explicit);
      assert.ok(requested[0]?.startsWith(`${explicit}/session`));
      cleanup();
    });
  });

  it('filters sessions by workspacePath', async () => {
    const { app, cleanup } = await makeApp();
    stubSessions([
      { id: 'ses_a', title: 'A', directory: 'D:/ws' },
      { id: 'ses_b', title: 'B', directory: 'D:/other' }
    ]);
    const workspace = 'D:/ws';
    const res = await app.inject({
      method: 'GET',
      url: `/api/opencode/sessions?url=${encodeURIComponent('http://127.0.0.1:4096')}&workspacePath=${encodeURIComponent(` ${workspace} `)}`
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json<{ workspacePath: string }>().workspacePath, workspace);
    assert.deepEqual(res.json<{ sessions: { id: string }[] }>().sessions.map(s => s.id), ['ses_a']);
    cleanup();
  });

  it('maps upstream failures to 502', async () => {
    const { app, cleanup } = await makeApp();
    globalThis.fetch = (async () => { throw new Error('boom'); }) as typeof fetch;
    const res = await app.inject({
      method: 'GET', url: `/api/opencode/sessions?url=${encodeURIComponent('http://127.0.0.1:4096')}`
    });
    assert.equal(res.statusCode, 502);
    cleanup();
  });
});

describe('OpenAPI contract', () => {
  it('documents defaultSessionId, the session header, and stateless discovery', async () => {
    const { app, cleanup } = await makeApp();
    const spec = (await app.inject({ method: 'GET', url: '/api/openapi.json' })).json<{
      paths: Record<string, { get?: { parameters?: Array<{ name: string }> } }>;
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    }>();
    assert.ok(spec.paths['/api/opencode/sessions']);
    assert.ok(spec.components.schemas.CreateProjectRequest?.properties?.defaultSessionId);
    assert.ok(spec.components.schemas.Project?.properties?.defaultSessionId);
    cleanup();
  });
});

describe('directory server inheritance', () => {
  it('persists serverUrl and lets projects inherit it', async () => {
    const { app, cleanup } = await makeApp();
    const dirRes = await app.inject({
      method: 'POST', url: '/api/directories', headers: json,
      payload: { name: 'D', workspacePath: 'D:/ws', serverUrl: 'http://10.0.0.5:4096' }
    });
    assert.equal(dirRes.statusCode, 201, dirRes.body);
    const directory = dirRes.json<{ id: string; serverUrl: string }>();
    assert.equal(directory.serverUrl, 'http://10.0.0.5:4096');

    const patched = await app.inject({
      method: 'PATCH', url: `/api/directories/${directory.id}`, headers: json,
      payload: { serverUrl: 'http://10.0.0.6:4096' }
    });
    assert.equal(patched.statusCode, 200, patched.body);
    assert.equal(patched.json<{ serverUrl: string }>().serverUrl, 'http://10.0.0.6:4096');

    stubSessions([{ id: 'ses_d', title: 'D', directory: 'D:/ws' }]);
    const res = await postProject(app, {
      name: 'P', directoryId: directory.id, defaultSessionId: 'ses_d'
    }, 'web');
    assert.equal(res.statusCode, 201, res.body);
    const project = res.json<{ wakeChannel: string; workspacePath: string }>();
    assert.equal(project.wakeChannel, 'http://10.0.0.6:4096');
    assert.equal(project.workspacePath, 'D:/ws');
    cleanup();
  });
});

describe('global defaults', () => {
  it('persists the default OpenCode Server URL', async () => {
    const { app, cleanup } = await makeApp();
    const put = await app.inject({
      method: 'PUT', url: '/api/settings', headers: json,
      payload: { defaultWorkspacePath: 'D:/ws', defaultOpenCodeServerUrl: 'http://127.0.0.1:4096' }
    });
    assert.equal(put.statusCode, 200, put.body);
    const got = (await app.inject({ method: 'GET', url: '/api/settings' })).json<{
      defaultWorkspacePath: string; defaultOpenCodeServerUrl: string;
    }>();
    assert.equal(got.defaultWorkspacePath, 'D:/ws');
    assert.equal(got.defaultOpenCodeServerUrl, 'http://127.0.0.1:4096');
    cleanup();
  });
});
