// Project-level default OpenCode sessions (server layer):
// new issues inherit project.sessionId unless an explicit body value or the
// x-taskboard-session header overrides it. Also covers the stateless session
// discovery endpoint used by the web create-project flow.

import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { FALLBACK_OPENCODE_URL } from '../src/opencode.js';
import type { FastifyInstance } from 'fastify';

type Env = Record<string, string | undefined>;

const OPENCODE_ENV = 'TASKBOARD_OPENCODE_URL';

// Resolve defaults read process.env directly, so every test that exercises a
// fallback sets/restores it explicitly (never inherits the developer's shell).
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

const json = { 'content-type': 'application/json' };

async function createProject(app: FastifyInstance, payload: Record<string, unknown>, actor?: string): Promise<FastifyInstance> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: actor ? { ...json, 'x-taskboard-actor': actor } : json,
    payload
  });
  assert.equal(res.statusCode, 201, res.body);
  return app;
}

async function createIssue(app: FastifyInstance, projectId: string, payload: Record<string, unknown>, headers: Record<string, string>): Promise<{ statusCode: number; body: { sessionId?: string | null; error?: string } }> {
  const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/issues`, headers: { ...json, ...headers }, payload });
  return { statusCode: res.statusCode, body: res.json() };
}

describe('issue creation inherits the project default session', () => {
  it('web create in a project with a default session succeeds without a body sessionId', async () => {
    const { app, cleanup } = await makeApp();
    await createProject(app, { id: 'p1', name: 'P', sessionId: 'ses_project' });
    const res = await createIssue(app, 'p1', { title: 'inherit' }, { 'x-taskboard-actor': 'web' });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(res.body.sessionId, 'ses_project');
    cleanup();
  });

  it('web create in a legacy project without any session is rejected', async () => {
    const { app, cleanup } = await makeApp();
    await createProject(app, { id: 'p1', name: 'P' });
    const res = await createIssue(app, 'p1', { title: 'must bind' }, { 'x-taskboard-actor': 'web' });
    assert.equal(res.statusCode, 400);
    assert.match(String(res.body.error), /sessionId/);
    cleanup();
  });

  it('agent create without a header inherits the project session', async () => {
    const { app, cleanup } = await makeApp();
    await createProject(app, { id: 'p1', name: 'P', sessionId: 'ses_project' });
    const res = await createIssue(app, 'p1', { title: 'cli' }, { 'x-taskboard-actor': 'cli' });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.sessionId, 'ses_project');
    cleanup();
  });

  it('x-taskboard-session overrides the project default', async () => {
    const { app, cleanup } = await makeApp();
    await createProject(app, { id: 'p1', name: 'P', sessionId: 'ses_project' });
    const res = await createIssue(app, 'p1', { title: 'header' }, { 'x-taskboard-actor': 'cli', 'x-taskboard-session': 'ses_agent' });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.sessionId, 'ses_agent');
    cleanup();
  });

  it('an explicit body sessionId overrides both the header and the project default', async () => {
    const { app, cleanup } = await makeApp();
    await createProject(app, { id: 'p1', name: 'P', sessionId: 'ses_project' });
    const res = await createIssue(app, 'p1', { title: 'body', sessionId: 'ses_body' }, { 'x-taskboard-actor': 'cli', 'x-taskboard-session': 'ses_agent' });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.sessionId, 'ses_body');
    cleanup();
  });

  it('agent create in a legacy project stays unbound', async () => {
    const { app, cleanup } = await makeApp();
    await createProject(app, { id: 'p1', name: 'P' });
    const res = await createIssue(app, 'p1', { title: 'legacy' }, { 'x-taskboard-actor': 'cli' });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.sessionId, null);
    cleanup();
  });
});

describe('project create gate and default wake channel', () => {
  it('web project create without sessionId is rejected', async () => {
    const { app, cleanup } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { ...json, 'x-taskboard-actor': 'web' },
      payload: { id: 'no-session', name: 'P', wakeChannel: 'http://127.0.0.1:4096' }
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json<{ error: string }>().error, /sessionId/);
    cleanup();
  });

  it('web project create without wakeChannel uses TASKBOARD_OPENCODE_URL', async () => {
    await withOpenCodeEnv('http://host.docker.internal:4096', async () => {
      const { app, cleanup } = await makeApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { ...json, 'x-taskboard-actor': 'web' },
        payload: { id: 'p1', name: 'P', sessionId: 'ses_x' }
      });
      assert.equal(res.statusCode, 201, res.body);
      assert.equal(res.json<{ wakeChannel: string }>().wakeChannel, 'http://host.docker.internal:4096');
      cleanup();
    });
  });

  it('web project create without wakeChannel falls back to the newest project wakeChannel', async () => {
    await withOpenCodeEnv(undefined, async () => {
      const { app, cleanup } = await makeApp();
      await createProject(app, { id: 'old', name: 'Old', wakeChannel: 'http://10.0.0.1:4096' });
      await createProject(app, { id: 'new', name: 'New', wakeChannel: 'http://10.0.0.2:4096' });
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { ...json, 'x-taskboard-actor': 'web' },
        payload: { id: 'p1', name: 'P', sessionId: 'ses_x' }
      });
      assert.equal(res.statusCode, 201, res.body);
      assert.equal(res.json<{ wakeChannel: string }>().wakeChannel, 'http://10.0.0.2:4096');
      cleanup();
    });
  });

  it('web project create without wakeChannel falls back to 127.0.0.1:4096', async () => {
    await withOpenCodeEnv(undefined, async () => {
      const { app, cleanup } = await makeApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { ...json, 'x-taskboard-actor': 'web' },
        payload: { id: 'p1', name: 'P', sessionId: 'ses_x' }
      });
      assert.equal(res.statusCode, 201, res.body);
      assert.equal(res.json<{ wakeChannel: string }>().wakeChannel, FALLBACK_OPENCODE_URL);
      cleanup();
    });
  });

  it('non-web project create without wakeChannel/sessionId is still allowed', async () => {
    const { app, cleanup } = await makeApp();
    await createProject(app, { id: 'p1', name: 'P' });
    cleanup();
  });

  it('PATCH sets and clears the project sessionId and GET reflects it', async () => {
    const { app, cleanup } = await makeApp();
    await createProject(app, { id: 'p1', name: 'P' });

    const set = await app.inject({ method: 'PATCH', url: '/api/projects/p1', headers: json, payload: { sessionId: 'ses_default' } });
    assert.equal(set.statusCode, 200);
    assert.equal(set.json<{ sessionId: string }>().sessionId, 'ses_default');

    const got = await app.inject({ method: 'GET', url: '/api/projects/p1' });
    assert.equal(got.json<{ sessionId: string }>().sessionId, 'ses_default');

    const clear = await app.inject({ method: 'PATCH', url: '/api/projects/p1', headers: json, payload: { sessionId: '' } });
    assert.equal(clear.statusCode, 200);
    assert.equal(clear.json<{ sessionId: string }>().sessionId, '');

    const gotAfter = await app.inject({ method: 'GET', url: '/api/projects/p1' });
    assert.equal(gotAfter.json<{ sessionId: string }>().sessionId, '');
    cleanup();
  });
});

describe('GET /api/opencode/sessions', () => {
  const realFetch = globalThis.fetch;

  function stubFetch(impl: typeof fetch): void {
    globalThis.fetch = impl;
  }

  function restore(): void {
    globalThis.fetch = realFetch;
  }

  it('rejects a non-http(s) explicit url', async () => {
    const { app, cleanup } = await makeApp();
    const invalid = await app.inject({ method: 'GET', url: '/api/opencode/sessions?url=file:///tmp/opencode' });
    assert.equal(invalid.statusCode, 400);
    assert.match(invalid.json<{ error: string }>().error, /^url: /);
    cleanup();
  });

  it('resolves a blank url from TASKBOARD_OPENCODE_URL', async () => {
    await withOpenCodeEnv('http://host.docker.internal:4096', async () => {
      const requested: string[] = [];
      stubFetch(async input => {
        requested.push(String(input));
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      });
      try {
        const { app, cleanup } = await makeApp();
        const res = await app.inject({ method: 'GET', url: '/api/opencode/sessions' });
        assert.equal(res.statusCode, 200, res.body);
        assert.deepEqual(requested, ['http://host.docker.internal:4096/session']);
        assert.equal(res.json<{ serverUrl: string }>().serverUrl, 'http://host.docker.internal:4096');
        cleanup();
      } finally {
        restore();
      }
    });
  });

  it('resolves a blank url to the fallback when no env or projects exist', async () => {
    await withOpenCodeEnv(undefined, async () => {
      const requested: string[] = [];
      stubFetch(async input => {
        requested.push(String(input));
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      });
      try {
        const { app, cleanup } = await makeApp();
        const res = await app.inject({ method: 'GET', url: '/api/opencode/sessions' });
        assert.equal(res.statusCode, 200, res.body);
        assert.deepEqual(requested, [`${FALLBACK_OPENCODE_URL}/session`]);
        assert.equal(res.json<{ serverUrl: string }>().serverUrl, FALLBACK_OPENCODE_URL);
        cleanup();
      } finally {
        restore();
      }
    });
  });

  it('an explicit url overrides env and project wakeChannel', async () => {
    await withOpenCodeEnv('http://10.0.0.9:4096', async () => {
      const requested: string[] = [];
      stubFetch(async input => {
        requested.push(String(input));
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      });
      try {
        const { app, cleanup } = await makeApp();
        await createProject(app, { id: 'p1', name: 'P', wakeChannel: 'http://10.0.0.2:4096' });
        const explicit = 'http://10.0.0.3:4096';
        const res = await app.inject({ method: 'GET', url: `/api/opencode/sessions?url=${encodeURIComponent(explicit)}` });
        assert.equal(res.statusCode, 200, res.body);
        assert.deepEqual(requested, [`${explicit}/session`]);
        assert.equal(res.json<{ serverUrl: string }>().serverUrl, explicit);
        cleanup();
      } finally {
        restore();
      }
    });
  });

  it('returns sessions filtered by workspacePath', async () => {
    const workspace = process.cwd();
    const other = join(workspace, 'other-workspace');
    stubFetch(async () => new Response(JSON.stringify([
      { id: 'ses_match', title: 'match', directory: workspace, time: { updated: 1 } },
      { id: 'ses_other', title: 'other', directory: other, time: { updated: 2 } }
    ]), { status: 200, headers: { 'content-type': 'application/json' } }));
    try {
      const { app, cleanup } = await makeApp();
      const url = `/api/opencode/sessions?url=${encodeURIComponent('http://127.0.0.1:4096')}&workspacePath=${encodeURIComponent(` ${workspace} `)}`;
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json<{ sessions: Array<{ id: string }>; workspacePath: string; serverUrl: string }>();
      assert.deepEqual(body.sessions.map(s => s.id), ['ses_match']);
      assert.equal(body.workspacePath, workspace);
      assert.equal(body.serverUrl, 'http://127.0.0.1:4096');
      cleanup();
    } finally {
      restore();
    }
  });

  it('maps upstream failures to 502', async () => {
    stubFetch(async () => { throw new Error('boom'); });
    try {
      const { app, cleanup } = await makeApp();
      const res = await app.inject({ method: 'GET', url: `/api/opencode/sessions?url=${encodeURIComponent('http://127.0.0.1:4096')}` });
      assert.equal(res.statusCode, 502);
      assert.match(res.json<{ error: string }>().error, /无法读取 OpenCode 会话/);
      cleanup();
    } finally {
      restore();
    }

    stubFetch(async () => new Response('nope', { status: 500 }));
    try {
      const { app, cleanup } = await makeApp();
      const res = await app.inject({ method: 'GET', url: `/api/opencode/sessions?url=${encodeURIComponent('http://127.0.0.1:4096')}` });
      assert.equal(res.statusCode, 502);
      assert.match(res.json<{ error: string }>().error, /无法读取 OpenCode 会话/);
      cleanup();
    } finally {
      restore();
    }
  });
});

describe('openapi contract', () => {
  it('documents the session header, project sessionId, and stateless sessions endpoint', async () => {
    const { app, cleanup } = await makeApp();
    const spec = (await app.inject({ method: 'GET', url: '/api/openapi.json' })).json<{
      paths: Record<string, { get?: { description?: string; parameters?: Array<{ name: string; required?: boolean }> } }>;
      components: { schemas: Record<string, { properties?: Record<string, unknown> }>; parameters: Record<string, unknown> };
    }>();
    assert.ok(spec.components.parameters.Session, 'x-taskboard-session parameter');
    assert.ok(spec.components.schemas.CreateProjectRequest.properties?.sessionId);
    const stateless = spec.paths['/api/opencode/sessions'].get!;
    assert.ok(stateless.description?.includes('TASKBOARD_OPENCODE_URL'), 'documents the env override');
    assert.equal(stateless.parameters?.find(p => p.name === 'url')?.required, false, 'url is optional');
    assert.ok(spec.paths['/api/opencode/sessions']);
    const createIssue = JSON.stringify(spec.paths['/api/projects/{projectId}/issues'].post);
    assert.ok(createIssue.includes('#/components/parameters/Session'), 'createIssue references the session header parameter');
    cleanup();
  });
});
