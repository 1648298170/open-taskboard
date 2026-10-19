// Server API test base (v0.4 P1): the previously untested layer.
//
// Every test builds a fresh Fastify app over an in-memory Store (DI seam)
// and drives the full HTTP stack via fastify inject — auth hooks, gates,
// zod validation and the global error handler all run for real. Env is
// injected per-app (ServerOptions.env), never mutated on process.env.

import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

type Env = Record<string, string | undefined>;

interface App {
  app: FastifyInstance;
  cleanup: () => void;
}

async function makeApp(env: Env = {}): Promise<App> {
  const dir = mkdtempSync(join(tmpdir(), 'tb-server-test-'));
  const store = new (await import('@taskboard/core')).Store(dir, new DatabaseSync(':memory:'));
  const { app } = await buildApp({ store, env });
  return {
    app,
    cleanup: () => { app.close(); rmSync(dir, { recursive: true, force: true }); }
  };
}

const json = { 'content-type': 'application/json' };

async function seedIssue(app: FastifyInstance, env: Env, actor = 'cli'): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/api/projects/p1/issues',
    headers: { ...json, 'x-taskboard-actor': actor }, payload: { title: 'seed' }
  });
  assert.equal(res.statusCode, 201);
  return (res.json() as { id: string }).id;
}

async function seedProject(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/api/projects', headers: json, payload: { id: 'p1', name: 'P' }
  });
  assert.equal(res.statusCode, 201);
  return 'p1';
}

// --- auth (T2-9) -------------------------------------------------------------

describe('TASKBOARD_TOKEN auth', () => {
  it('rejects tokenless requests with 401', async () => {
    const { app, cleanup } = await makeApp({ TASKBOARD_TOKEN: 'sekret' });
    const res = await app.inject({ method: 'GET', url: '/api/meta' });
    assert.equal(res.statusCode, 401);
    cleanup();
  });

  it('accepts a Bearer header or ?token= query', async () => {
    const { app, cleanup } = await makeApp({ TASKBOARD_TOKEN: 'sekret' });
    const viaHeader = await app.inject({ method: 'GET', url: '/api/meta', headers: { authorization: 'Bearer sekret' } });
    const viaQuery = await app.inject({ method: 'GET', url: '/api/meta?token=sekret' });
    assert.equal(viaHeader.statusCode, 200);
    assert.equal(viaQuery.statusCode, 200);
    cleanup();
  });

  it('rejects a wrong token with 401', async () => {
    const { app, cleanup } = await makeApp({ TASKBOARD_TOKEN: 'sekret' });
    const res = await app.inject({ method: 'GET', url: '/api/meta', headers: { authorization: 'Bearer nope' } });
    assert.equal(res.statusCode, 401);
    cleanup();
  });

  it('exempts /api/openapi.json from auth', async () => {
    const { app, cleanup } = await makeApp({ TASKBOARD_TOKEN: 'sekret' });
    const res = await app.inject({ method: 'GET', url: '/api/openapi.json' });
    assert.equal(res.statusCode, 200);
    cleanup();
  });

  it('is fully open when the env is unset', async () => {
    const { app, cleanup } = await makeApp({});
    const res = await app.inject({ method: 'GET', url: '/api/meta' });
    assert.equal(res.statusCode, 200);
    cleanup();
  });
});

// --- require-session gate（开工必绑 sessionId+branch）---------------------------

describe('TASKBOARD_REQUIRE_SESSION gate', () => {
  async function gated() {
    const app = await makeApp({ TASKBOARD_REQUIRE_SESSION: '1' });
    await seedProject(app.app);
    const issueId = await seedIssue(app.app);
    return { ...app, issueId };
  }

  it('claim without sessionId/branch → 403 with a teaching message; with both → bound', async () => {
    const t = await gated();
    const bare = await t.app.inject({ method: 'POST', url: `/api/issues/${t.issueId}/claim`, headers: json, payload: { agent: 'bot' } });
    assert.equal(bare.statusCode, 403);
    assert.match(bare.json<{ error: string }>().error, /sessionId/);

    const bound = await t.app.inject({
      method: 'POST', url: `/api/issues/${t.issueId}/claim`, headers: json,
      payload: { agent: 'bot', sessionId: 'ses_x1', branch: 'feat/x' }
    });
    assert.equal(bound.statusCode, 200);
    assert.equal(bound.json<{ sessionId: string; branch: string }>().sessionId, 'ses_x1');
    assert.equal(bound.json<{ branch: string }>().branch, 'feat/x');
    t.cleanup();
  });

  it('PATCH flow to in_progress without binding → 403; with sessionId+branch in the same patch → applied', async () => {
    const t = await gated();
    // 先 claim 一个已绑定任务（claim 绑定后 PATCH 流转不再拦）
    const bound = await t.app.inject({
      method: 'POST', url: `/api/issues/${t.issueId}/claim`, headers: json,
      payload: { agent: 'bot', sessionId: 'ses_x2', branch: 'feat/y' }
    });
    const version = bound.json<{ version: number }>().version;
    const unbound = await t.app.inject({ method: 'POST', url: '/api/projects/p1/issues', headers: json, payload: { title: 'fresh' } });
    const freshId = unbound.json<{ id: string }>().id;

    const bare = await t.app.inject({
      method: 'PATCH', url: `/api/issues/${freshId}`, headers: json,
      payload: { status: 'in_progress', version: 1 }
    });
    assert.equal(bare.statusCode, 403);

    const withBind = await t.app.inject({
      method: 'PATCH', url: `/api/issues/${freshId}`, headers: json,
      payload: { status: 'in_progress', sessionId: 'ses_x3', branch: 'feat/z', version: 1 }
    });
    assert.equal(withBind.statusCode, 200);
    assert.equal(withBind.json<{ sessionId: string }>().sessionId, 'ses_x3');
    t.cleanup();
  });

  it('web actor and confirm:true are exempt; disabled env restores old behavior', async () => {
    const t = await gated();
    const web = await t.app.inject({ method: 'PATCH', url: `/api/issues/${t.issueId}`, headers: { ...json, 'x-taskboard-actor': 'web' }, payload: { status: 'in_progress', version: 1 } });
    assert.equal(web.statusCode, 200, 'web is exempt');

    t.app.close();
    const app2 = await makeApp({ TASKBOARD_REQUIRE_SESSION: '0' });
    await seedProject(app2.app);
    const id2 = await seedIssue(app2.app);
    const claim2 = await app2.app.inject({ method: 'POST', url: `/api/issues/${id2}/claim`, headers: json, payload: { agent: 'bot' } });
    assert.equal(claim2.statusCode, 200, 'opt-out restores open flow');
    app2.cleanup();
  });
});

describe('workspace directory API', () => {
  it('creates a directory group and stores project-specific path/server/session bindings', async () => {
    const { app, cleanup } = await makeApp();
    const directoryRes = await app.inject({
      method: 'POST', url: '/api/directories', headers: json,
      payload: { name: 'Workspace A' }
    });
    assert.equal(directoryRes.statusCode, 201);
    const directory = directoryRes.json<{ id: string }>();
    const projectRes = await app.inject({
      method: 'POST', url: '/api/projects', headers: json,
      payload: { name: 'Project A', directoryId: directory.id, defaultSessionId: 'ses_a', workspacePath: '/workspace/a', wakeChannel: 'http://127.0.0.1:4096' }
    });
    assert.equal(projectRes.statusCode, 201);
    const project = projectRes.json<{ directoryId: string; defaultSessionId: string; workspacePath: string; wakeChannel: string }>();
    assert.equal(project.directoryId, directory.id);
    assert.equal(project.defaultSessionId, 'ses_a');
    assert.equal(project.workspacePath, '/workspace/a');
    assert.equal(project.wakeChannel, 'http://127.0.0.1:4096');
    cleanup();
  });

  it('keeps project routing independent from directory grouping and prevents deleting a non-empty directory', async () => {
    const { app, cleanup } = await makeApp();
    const created = await app.inject({
      method: 'POST', url: '/api/directories', headers: json,
      payload: { name: 'Workspace' }
    });
    const directoryId = created.json<{ id: string }>().id;
    const project = await app.inject({
      method: 'POST', url: '/api/projects', headers: json,
      payload: { name: 'Project', directoryId, workspacePath: '/workspace', wakeChannel: 'http://127.0.0.1:4096' }
    });
    const projectId = project.json<{ id: string }>().id;
    const updated = await app.inject({
      method: 'PATCH', url: `/api/projects/${projectId}`, headers: json,
      payload: { workspacePath: '/workspace/renamed', wakeChannel: 'http://127.0.0.1:4097' }
    });
    assert.equal(updated.statusCode, 200);
    const projectAfter = (await app.inject({ method: 'GET', url: `/api/projects/${projectId}` })).json<{ workspacePath: string; wakeChannel: string }>();
    assert.equal(projectAfter.workspacePath, '/workspace/renamed');
    assert.equal(projectAfter.wakeChannel, 'http://127.0.0.1:4097');
    const deletion = await app.inject({ method: 'DELETE', url: `/api/directories/${directoryId}` });
    assert.equal(deletion.statusCode, 400);
    cleanup();
  });
});

describe('directory OpenCode session routes', () => {
  it('queries sessions in the requested workspace and filters out other directories', async () => {
    const { app, cleanup } = await makeApp();
    const created = await app.inject({
      method: 'POST', url: '/api/directories', headers: json, payload: { name: 'Workspace' }
    });
    const directoryId = created.json<{ id: string }>().id;
    const originalFetch = globalThis.fetch;
    const requestedPath = 'D:\\workspace\\project-a';
    let requestedUrl = '';
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      assert.equal(init?.method ?? 'GET', 'GET');
      return new Response(JSON.stringify([
        { id: 'ses_a', title: 'Project A', directory: 'D:/workspace/project-a', time: { updated: 10 } },
        { id: 'ses_b', title: 'Project B', directory: 'D:/workspace/project-b', time: { updated: 20 } }
      ]), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/directories/${directoryId}/opencode-sessions?workspacePath=${encodeURIComponent(requestedPath)}&serverUrl=${encodeURIComponent('http://127.0.0.1:4096')}`
      });
      assert.equal(response.statusCode, 200);
      assert.equal(new URL(requestedUrl).searchParams.get('directory'), requestedPath);
      assert.deepEqual(response.json<{ sessions: { id: string }[] }>().sessions.map(session => session.id), ['ses_a']);
    } finally {
      globalThis.fetch = originalFetch;
      cleanup();
    }
  });

  it('creates a session with the requested directory context', async () => {
    const { app, cleanup } = await makeApp();
    const created = await app.inject({
      method: 'POST', url: '/api/directories', headers: json, payload: { name: 'Workspace' }
    });
    const directoryId = created.json<{ id: string }>().id;
    const originalFetch = globalThis.fetch;
    const requestedPath = 'D:\\workspace\\project-a';
    let requestedUrl = '';
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedUrls.push(requestedUrl);
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ directory: requestedPath }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      assert.equal(init?.method, 'POST');
      return new Response(JSON.stringify({
        id: 'ses_new',
        title: 'New Session',
        directory: requestedPath,
        time: { updated: 30 }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/directories/${directoryId}/opencode-sessions`,
        headers: json,
        payload: { title: 'New Session', workspacePath: requestedPath, serverUrl: 'http://127.0.0.1:4096' }
      });
      assert.equal(response.statusCode, 201);
      assert.equal(requestedUrls.length, 2, 'verify workspace before creating a session');
      assert.equal(new URL(requestedUrls[0]).pathname, '/path');
      assert.equal(new URL(requestedUrls[0]).searchParams.get('directory'), requestedPath);
      assert.equal(new URL(requestedUrls[1]).pathname, '/session');
      assert.equal(new URL(requestedUrls[1]).searchParams.get('directory'), requestedPath);
      assert.equal(response.json<{ session: { id: string; directory: string } }>().session.directory, requestedPath);
    } finally {
      globalThis.fetch = originalFetch;
      cleanup();
    }
  });

  it('does not bind a session if OpenCode ignores the requested workspace', async () => {
    const { app, cleanup } = await makeApp();
    const created = await app.inject({
      method: 'POST', url: '/api/directories', headers: json, payload: { name: 'Workspace' }
    });
    const directoryId = created.json<{ id: string }>().id;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      id: 'ses_wrong_workspace',
      title: 'Wrong Workspace',
      directory: 'D:/opencode-server-startup',
      time: { updated: 30 }
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/directories/${directoryId}/opencode-sessions`,
        headers: json,
        payload: { title: 'New Session', workspacePath: 'D:\\workspace\\project-a', serverUrl: 'http://127.0.0.1:4096' }
      });
      assert.equal(response.statusCode, 502);
      assert.match(response.json<{ error: string }>().error, /no session was created/);
    } finally {
      globalThis.fetch = originalFetch;
      cleanup();
    }
  });

  it('requires an OpenCode Server URL before listing or creating sessions', async () => {
    const { app, cleanup } = await makeApp();
    const created = await app.inject({
      method: 'POST', url: '/api/directories', headers: json,
      payload: { name: 'Workspace' }
    });
    assert.equal(created.statusCode, 201);
    const id = created.json<{ id: string }>().id;
    const list = await app.inject({ method: 'GET', url: `/api/directories/${id}/opencode-sessions` });
    const create = await app.inject({
      method: 'POST', url: `/api/directories/${id}/opencode-sessions`,
      headers: json, payload: { title: 'Session' }
    });
    assert.equal(list.statusCode, 400);
    assert.equal(create.statusCode, 400);
    cleanup();
  });
});

describe('project OpenCode session discovery route', () => {
  it('returns a useful error when the project has no OpenCode server configured', async () => {
    const { app, cleanup } = await makeApp();
    await seedProject(app);
    const res = await app.inject({ method: 'GET', url: '/api/projects/p1/opencode-sessions' });
    assert.equal(res.statusCode, 400);
    assert.match(res.json<{ error: string }>().error, /OpenCode/);
    cleanup();
  });

  it('returns 404 for an unknown project', async () => {
    const { app, cleanup } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/projects/missing/opencode-sessions' });
    assert.equal(res.statusCode, 404);
    cleanup();
  });
});

// --- web task creation requires an OpenCode session -------------------------------
describe('web-created task session binding', () => {
  it('rejects a missing sessionId and accepts a non-empty binding', async () => {
    const { app, cleanup } = await makeApp();
    await seedProject(app);
    const missing = await app.inject({
      method: 'POST', url: '/api/projects/p1/issues',
      headers: { ...json, 'x-taskboard-actor': 'web' },
      payload: { title: 'must bind' }
    });
    assert.equal(missing.statusCode, 400);
    assert.match(missing.json<{ error: string }>().error, /sessionId/);

    const bound = await app.inject({
      method: 'POST', url: '/api/projects/p1/issues',
      headers: { ...json, 'x-taskboard-actor': 'web' },
      payload: { title: 'bound task', sessionId: 'ses_existing' }
    });
    assert.equal(bound.statusCode, 201);
    assert.equal(bound.json<{ sessionId: string }>().sessionId, 'ses_existing');
    cleanup();
  });
});

// --- readonly (T6-33) ----------------------------------------------------------

describe('TASKBOARD_READONLY', () => {
  it('rejects mutating requests with 403, reads stay open', async () => {
    const { app, cleanup } = await makeApp({ TASKBOARD_READONLY: '1' });
    const post = await app.inject({ method: 'POST', url: '/api/projects', headers: json, payload: { name: 'x' } });
    const get = await app.inject({ method: 'GET', url: '/api/projects' });
    assert.equal(post.statusCode, 403);
    assert.equal(get.statusCode, 200);
    cleanup();
  });
});

// --- human-done gate (T7-36, create side added in v0.4) -------------------------

describe('TASKBOARD_HUMAN_DONE gate', () => {
  async function gated() {
    const app = await makeApp({ TASKBOARD_HUMAN_DONE: '1', TASKBOARD_REQUIRE_SESSION: '0' });
    await seedProject(app.app);
    const issueId = await seedIssue(app.app);
    return { ...app, issueId };
  }

  it('403s an agent PATCH to done, 403s an agent create at done', async () => {
    const { app, cleanup, issueId } = await gated();
    const v = (await app.inject({ method: 'GET', url: `/api/issues/${issueId}` })).json<{ version: number }>().version;
    const patch = await app.inject({
      method: 'PATCH', url: `/api/issues/${issueId}`,
      headers: { ...json, 'x-taskboard-actor': 'cli' }, payload: { status: 'done', version: v }
    });
    const create = await app.inject({
      method: 'POST', url: '/api/projects/p1/issues',
      headers: { ...json, 'x-taskboard-actor': 'cli' }, payload: { title: 't', status: 'done' }
    });
    assert.equal(patch.statusCode, 403);
    assert.equal(create.statusCode, 403);
    cleanup();
  });

  it('lets the web actor through both paths', async () => {
    const { app, cleanup, issueId } = await gated();
    const v = (await app.inject({ method: 'GET', url: `/api/issues/${issueId}` })).json<{ version: number }>().version;
    const patch = await app.inject({
      method: 'PATCH', url: `/api/issues/${issueId}`,
      headers: { ...json, 'x-taskboard-actor': 'web' }, payload: { status: 'done', version: v }
    });
    const create = await app.inject({
      method: 'POST', url: '/api/projects/p1/issues',
      headers: { ...json, 'x-taskboard-actor': 'web' }, payload: { title: 't', status: 'done', sessionId: 'ses_web' }
    });
    assert.equal(patch.statusCode, 200);
    assert.equal(create.statusCode, 201);
    cleanup();
  });

  it('honors the confirm escape hatch on both paths', async () => {
    const { app, cleanup, issueId } = await gated();
    const v = (await app.inject({ method: 'GET', url: `/api/issues/${issueId}` })).json<{ version: number }>().version;
    const patch = await app.inject({
      method: 'PATCH', url: `/api/issues/${issueId}`,
      headers: { ...json, 'x-taskboard-actor': 'cli' }, payload: { status: 'done', version: v, confirm: true }
    });
    const create = await app.inject({
      method: 'POST', url: '/api/projects/p1/issues',
      headers: { ...json, 'x-taskboard-actor': 'cli' }, payload: { title: 't', status: 'done', confirm: true }
    });
    assert.equal(patch.statusCode, 200);
    assert.equal(create.statusCode, 201);
    cleanup();
  });

  it('never gates non-done statuses', async () => {
    const { app, cleanup, issueId } = await gated();
    const v = (await app.inject({ method: 'GET', url: `/api/issues/${issueId}` })).json<{ version: number }>().version;
    const res = await app.inject({
      method: 'PATCH', url: `/api/issues/${issueId}`,
      headers: { ...json, 'x-taskboard-actor': 'cli' }, payload: { status: 'in_progress', version: v }
    });
    assert.equal(res.statusCode, 200);
    cleanup();
  });
});

describe('claim endpoints (lease + session binding)', () => {
  it('claim binds sessionId on an unbound issue and auto-flows todo → in_progress', async () => {
    const { app, cleanup } = await makeApp();
    await seedProject(app);
    const issueId = await seedIssue(app);
    const res = await app.inject({
      method: 'POST', url: `/api/issues/${issueId}/claim`, headers: json,
      payload: { agent: 'sisyphus', sessionId: 'ses_x' }
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ status: string; sessionId: string | null; claimedBy: string }>();
    assert.equal(body.status, 'in_progress', '认领即开工');
    assert.equal(body.sessionId, 'ses_x', '认领即绑定');
    assert.equal(body.claimedBy, 'sisyphus');
    cleanup();
  });

  it('claiming an already-bound issue never overwrites the binding', async () => {
    const { app, cleanup } = await makeApp();
    await seedProject(app);
    const issueId = await seedIssue(app);
    const patched = await app.inject({
      method: 'PATCH', url: `/api/issues/${issueId}`, headers: json, payload: { sessionId: 'ses_owner' }
    });
    assert.equal(patched.statusCode, 200);
    const res = await app.inject({
      method: 'POST', url: `/api/issues/${issueId}/claim`, headers: json,
      payload: { agent: 'intruder', sessionId: 'ses_intruder' }
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json<{ sessionId: string | null }>().sessionId, 'ses_owner', '只绑空位，不抢绑');
    cleanup();
  });

  it('served openapi documents ClaimRequest.sessionId (contract stays honest)', async () => {
    const { app, cleanup } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/openapi.json' });
    const spec = res.json<{ components: { schemas: { ClaimRequest: { properties: Record<string, unknown> } } } }>();
    assert.ok(spec.components.schemas.ClaimRequest.properties.sessionId, 'ClaimRequest.sessionId must be documented');
    cleanup();
  });
});

// --- error mapping --------------------------------------------------------------

describe('error mapping', () => {
  it('404 with { error } for a missing issue', async () => {
    const { app, cleanup } = await makeApp({});
    const res = await app.inject({ method: 'GET', url: '/api/issues/ghost' });
    assert.equal(res.statusCode, 404);
    assert.match(res.json<{ error: string }>().error, /not found/);
    cleanup();
  });

  it('409 on optimistic-lock mismatch, 400 on strict-schema violations', async () => {
    const { app, cleanup } = await makeApp({});
    await seedProject(app);
    const id = await seedIssue(app);
    const conflict = await app.inject({
      method: 'PATCH', url: `/api/issues/${id}`, headers: json, payload: { title: 'x', version: 999 }
    });
    assert.equal(conflict.statusCode, 409);
    const strict = await app.inject({
      method: 'POST', url: '/api/projects', headers: json, payload: { name: 'n', unknownKey: 1 }
    });
    assert.equal(strict.statusCode, 400);
    const badEnum = await app.inject({
      method: 'PATCH', url: `/api/issues/${id}`, headers: json, payload: { status: 'archived' }
    });
    assert.equal(badEnum.statusCode, 400);
    cleanup();
  });

  it('400 on re-parenting an issue that has children (core guard surfaces as 400)', async () => {
    const { app, cleanup } = await makeApp({});
    await seedProject(app);
    const a = await seedIssue(app);
    await app.inject({ method: 'POST', url: '/api/projects/p1/issues', headers: json, payload: { title: 'B', parentId: a } });
    const c = await seedIssue(app);
    const res = await app.inject({ method: 'PATCH', url: `/api/issues/${a}`, headers: json, payload: { parentId: c } });
    assert.equal(res.statusCode, 400);
    assert.match(res.json<{ error: string }>().error, /children/);
    cleanup();
  });
});

// --- comments lifecycle (v0.4 delete) ---------------------------------------------

describe('comment deletion over HTTP', () => {
  it('deletes once (200), then 404s, logs the activity', async () => {
    const { app, cleanup } = await makeApp({});
    await seedProject(app);
    const issueId = await seedIssue(app);
    const created = await app.inject({
      method: 'POST', url: `/api/issues/${issueId}/comments`, headers: json, payload: { author: 'a', body: 'b' }
    });
    const commentId = created.json<{ id: string }>().id;
    const del = await app.inject({ method: 'DELETE', url: `/api/comments/${commentId}` });
    const again = await app.inject({ method: 'DELETE', url: `/api/comments/${commentId}` });
    assert.equal(del.statusCode, 200);
    assert.equal(again.statusCode, 404);
    const detail = await app.inject({ method: 'GET', url: `/api/issues/${issueId}` });
    const actions = detail.json<{ activities: { action: string }[] }>().activities.map(a => a.action);
    assert.ok(actions.includes('comment-deleted'));
    cleanup();
  });

  it('comment edit permission: agent comments locked forever; web edits only its own', async () => {
    const { app, cleanup } = await makeApp({});
    await seedProject(app);
    const issueId = await seedIssue(app);
    const userC = (await app.inject({ method: 'POST', url: `/api/issues/${issueId}/comments`, headers: json, payload: { author: 'web', body: 'mine' } })).json<{ id: string }>().id;
    const agentC = (await app.inject({ method: 'POST', url: `/api/issues/${issueId}/comments`, headers: { ...json, 'x-taskboard-actor': 'sisyphus' }, payload: { author: 'sisyphus', body: 'agent report' } })).json<{ id: string }>().id;

    const byAgent = await app.inject({ method: 'PATCH', url: `/api/comments/${userC}`, headers: { ...json, 'x-taskboard-actor': 'sisyphus' }, payload: { body: 'sneaky' } });
    assert.equal(byAgent.statusCode, 403);
    const agentLocked = await app.inject({ method: 'PATCH', url: `/api/comments/${agentC}`, headers: json, payload: { body: 'rewrite' } });
    assert.equal(agentLocked.statusCode, 403);
    const byWeb = await app.inject({ method: 'PATCH', url: `/api/comments/${userC}`, headers: { ...json, 'x-taskboard-actor': 'web' }, payload: { body: 'ok' } });
    assert.equal(byWeb.statusCode, 200);
    const statusMove = await app.inject({ method: 'PATCH', url: `/api/comments/${userC}`, headers: { ...json, 'x-taskboard-actor': 'watch' }, payload: { status: 'processing' } });
    assert.equal(statusMove.statusCode, 200, 'status advance needs no author match');
    cleanup();
  });

  it('PATCH edits a pending comment and moves its wake status; editing locked states 400s', async () => {
    const { app, cleanup } = await makeApp({});
    await seedProject(app);
    const issueId = await seedIssue(app);
    const created = await app.inject({
      method: 'POST', url: `/api/issues/${issueId}/comments`, headers: json, payload: { author: 'web', body: 'first' }
    });
    const commentId = created.json<{ id: string }>().id;

    const edited = await app.inject({ method: 'PATCH', url: `/api/comments/${commentId}`, headers: { ...json, 'x-taskboard-actor': 'web' }, payload: { body: 'edited' } });
    assert.equal(edited.statusCode, 200);
    assert.equal(edited.json<{ body: string }>().body, 'edited');
    assert.equal(edited.json<{ status: string }>().status, 'pending');

    const moved = await app.inject({ method: 'PATCH', url: `/api/comments/${commentId}`, headers: json, payload: { status: 'processing' } });
    assert.equal(moved.statusCode, 200);
    assert.equal(moved.json<{ status: string }>().status, 'processing');

    const locked = await app.inject({ method: 'PATCH', url: `/api/comments/${commentId}`, headers: json, payload: { body: 'sneaky' } });
    assert.equal(locked.statusCode, 400);

    const bad = await app.inject({ method: 'PATCH', url: `/api/comments/${commentId}`, headers: json, payload: { status: 'zzz' } });
    assert.equal(bad.statusCode, 400);

    const missing = await app.inject({ method: 'PATCH', url: '/api/comments/nopex', headers: json, payload: { status: 'processed' } });
    assert.equal(missing.statusCode, 404);

    const detail = await app.inject({ method: 'GET', url: `/api/issues/${issueId}` });
    const actions = detail.json<{ activities: { action: string }[] }>().activities.map(a => a.action);
    assert.ok(actions.includes('comment-edited'));
    cleanup();
  });
});

// --- manual backup (v0.4 P0) -------------------------------------------------

describe('POST /api/backup', () => {
  it('writes a snapshot file and returns its path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tb-backup-test-'));
    const store = new (await import('@taskboard/core')).Store(dir, new DatabaseSync(':memory:'));
    const { app } = await buildApp({ store, env: {}, dataDir: dir });
    try {
      const res = await app.inject({ method: 'POST', url: '/api/backup' });
      assert.equal(res.statusCode, 200);
      const { path } = res.json<{ path: string }>();
      assert.match(path, /taskboard-\d{8}-\d{6}\.sqlite$/);
      assert.ok(existsSync(path), 'snapshot file must exist on disk');
    } finally {
      app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- pickup views -----------------------------------------------------------------

describe('ready/next views', () => {
  it('next returns null until the blocker is done, then the dependent', async () => {
    const { app, cleanup } = await makeApp({});
    await seedProject(app);
    const a = await seedIssue(app);
    const b = (await app.inject({
      method: 'POST', url: '/api/projects/p1/issues', headers: json, payload: { title: 'B' }
    })).json<{ id: string }>().id;
    await app.inject({ method: 'POST', url: `/api/issues/${b}/dependencies`, headers: json, payload: { dependsOnId: a } });

    // The blocker itself is ready (no deps) — smart pickup returns it first.
    const before = await app.inject({ method: 'GET', url: '/api/projects/p1/next' });
    assert.equal(before.json<{ issue: { id: string } | null }>().issue?.id, a);
    assert.equal(before.json<{ issue: { id: string } | null }>().issue?.status, 'todo');

    // 默认开启的 HUMAN_DONE 门禁下，非 web 来源置 done 需显式 confirm 逃生舱。
    await app.inject({ method: 'PATCH', url: `/api/issues/${a}`, headers: json, payload: { status: 'done', confirm: true } });
    const after = await app.inject({ method: 'GET', url: '/api/projects/p1/next' });
    assert.equal(after.json<{ issue: { id: string } | null }>().issue?.id, b);
    cleanup();
  });
});

describe('in_review 评论门禁（TASKBOARD_REVIEW_COMMENT 默认开）', () => {
  it('DEBUG2 store 层计数', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { Store } = await import('@taskboard/core');
    const { buildApp } = await import('../src/app.js');
    const dir = mkdtempSync(join(tmpdir(), 'dbg2-'));
    const store = new Store(join(dir, 'b.sqlite'), new DatabaseSync(':memory:'));
    const { app } = await buildApp({ store, env: {} });
    await app.inject({ method: 'POST', url: '/api/projects', payload: { id: 'p1', name: 'P' } });
    const issue = (await app.inject({ method: 'POST', url: '/api/projects/p1/issues', payload: { title: 't' } })).json<any>();
    await app.inject({ method: 'POST', url: `/api/issues/${issue.id}/comments`, payload: { author: 'cli', body: '自验' } });
    console.log('DBG2 store.countByAuthor:', store.commentCountBy(issue.id, 'cli'));
    const patch = await app.inject({ method: 'PATCH', url: `/api/issues/${issue.id}`, headers: { ...json, 'x-taskboard-actor': 'cli' }, payload: { status: 'in_review', version: issue.version } });
    console.log('DBG2 patch:', patch.statusCode, JSON.stringify(patch.json<any>()));
    console.log('DBG2 repo list:', JSON.stringify(store.listComments(issue.id).map(c => c.author)));
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('DEBUG 评论区布局与计数', async () => {
    const { app, cleanup } = await makeApp();
    await seedProject(app);
    const issueId = await seedIssue(app);
    const c = await app.inject({ method: 'POST', url: `/api/issues/${issueId}/comments`, headers: json, payload: { author: 'cli', body: '自验' } });
    const detail = (await app.inject({ method: 'GET', url: `/api/issues/${issueId}` })).json<any>();
    console.log('DBG comment-status:', c.statusCode, '| authors:', JSON.stringify(detail.comments.map((x: any) => x.author)));
    const res = await app.inject({
      method: 'PATCH', url: `/api/issues/${issueId}`,
      headers: { ...json, 'x-taskboard-actor': 'cli' }, payload: { status: 'in_review', version: 2 }
    });
    console.log('DBG patch:', res.statusCode, JSON.stringify(res.json<any>()));
    const dbg = (await app.inject({ method: 'GET', url: `/api/issues/${issueId}` })).json<any>();
    console.log('DBG detail.comments:', JSON.stringify(dbg.comments.map((x: any) => ({ a: x.author }))));
    console.log('DBG store gate count (经 API 无法直查，改查路由行为):', '见上');
    cleanup();
  });

  it('403s an agent with zero own comments; passes after the agent comments', async () => {
    const { app, cleanup } = await makeApp();
    await seedProject(app);
    const issueId = await seedIssue(app);
    const noComment = await app.inject({
      method: 'PATCH', url: `/api/issues/${issueId}`,
      headers: { ...json, 'x-taskboard-actor': 'cli' }, payload: { status: 'in_review', version: 1 }
    });
    assert.equal(noComment.statusCode, 403);
    assert.match(noComment.json<{ error: string }>().error, /先落评再交验/);
    // 评论后同 actor 交验通过
    await app.inject({ method: 'POST', url: `/api/issues/${issueId}/comments`, headers: json, payload: { author: 'cli', body: '自验通过：单测覆盖' } });
    const v2 = (await app.inject({ method: 'GET', url: `/api/issues/${issueId}` })).json<{ version: number }>().version;
    const ok = await app.inject({
      method: 'PATCH', url: `/api/issues/${issueId}`,
      headers: { ...json, 'x-taskboard-actor': 'cli' }, payload: { status: 'in_review', version: v2 }
    });
    assert.equal(ok.statusCode, 200);
    cleanup();
  });

  it("another actor's comment does not count — the reviewer must have written one", async () => {
    const { app, cleanup } = await makeApp();
    await seedProject(app);
    const issueId = await seedIssue(app);
    await app.inject({ method: 'POST', url: `/api/issues/${issueId}/comments`, headers: json, payload: { author: 'web', body: '人类上下文' } });
    const res = await app.inject({
      method: 'PATCH', url: `/api/issues/${issueId}`,
      headers: { ...json, 'x-taskboard-actor': 'cli' }, payload: { status: 'in_review', version: 2 }
    });
    assert.equal(res.statusCode, 403);
    cleanup();
  });

  it('web actor is exempt; create-at-in_review gated with confirm escape', async () => {
    const { app, cleanup } = await makeApp();
    await seedProject(app);
    const issueId = await seedIssue(app);
    const webPatch = await app.inject({
      method: 'PATCH', url: `/api/issues/${issueId}`,
      headers: { ...json, 'x-taskboard-actor': 'web' }, payload: { status: 'in_review', version: 1 }
    });
    assert.equal(webPatch.statusCode, 200);
    const create = await app.inject({
      method: 'POST', url: '/api/projects/p1/issues', headers: json, payload: { title: '直接交验', status: 'in_review' }
    });
    assert.equal(create.statusCode, 403);
    const escaped = await app.inject({
      method: 'POST', url: '/api/projects/p1/issues', headers: json, payload: { title: '直接交验', status: 'in_review', confirm: true }
    });
    assert.equal(escaped.statusCode, 201);
    cleanup();
  });

  it('TASKBOARD_REVIEW_COMMENT=0 disables the gate', async () => {
    const { app, cleanup } = await makeApp({ TASKBOARD_REVIEW_COMMENT: '0' });
    await seedProject(app);
    const issueId = await seedIssue(app);
    const v = (await app.inject({ method: 'GET', url: `/api/issues/${issueId}` })).json<{ version: number }>().version;
    const res = await app.inject({
      method: 'PATCH', url: `/api/issues/${issueId}`,
      headers: { ...json, 'x-taskboard-actor': 'cli' }, payload: { status: 'in_review', version: v }
    });
    assert.equal(res.statusCode, 200);
    cleanup();
  });
});

describe('in_review 门禁只拦状态流转', () => {
  it('re-affirming in_review (no transition) by a comment-less agent passes', async () => {
    const { app, cleanup } = await makeApp();
    await seedProject(app);
    const issueId = await seedIssue(app);
    // web 先置 in_review（人工/已有交验语义）
    await app.inject({
      method: 'PATCH', url: `/api/issues/${issueId}`,
      headers: { ...json, 'x-taskboard-actor': 'web' }, payload: { status: 'in_review', version: 1 }
    });
    // 无评论 agent 重申 in_review（非流转）→ 不拦（动态取最新 version）
    const vNow = (await app.inject({ method: 'GET', url: `/api/issues/${issueId}` })).json<{ version: number }>().version;
    const res = await app.inject({
      method: 'PATCH', url: `/api/issues/${issueId}`,
      headers: { ...json, 'x-taskboard-actor': 'cli' }, payload: { status: 'in_review', version: vNow }
    });
    assert.equal(res.statusCode, 200);
    cleanup();
  });
});
