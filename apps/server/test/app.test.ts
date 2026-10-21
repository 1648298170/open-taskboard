// Server API test base (v0.4 P1): the previously untested layer.
//
// Every test builds a fresh Fastify app over an in-memory Store (DI seam)
// and drives the full HTTP stack via fastify inject — auth hooks, gates,
// zod validation and the global error handler all run for real. Env is
// injected per-app (ServerOptions.env), never mutated on process.env.

import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';
import type { Store } from '@taskboard/core';

type Env = Record<string, string | undefined>;

interface App {
  app: FastifyInstance;
  store: Store;
  cleanup: () => void;
}

async function makeApp(env: Env = {}): Promise<App> {
  const dir = mkdtempSync(join(tmpdir(), 'tb-server-test-'));
  const store = new (await import('@taskboard/core')).Store(dir, new DatabaseSync(':memory:'));
  const { app } = await buildApp({ store, env, dataDir: dir });
  return {
    app,
    store,
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

describe('global application settings', () => {
  it('persists the default workspace path and validates updates', async () => {
    const { app, cleanup } = await makeApp();
    try {
      const initial = await app.inject({ method: 'GET', url: '/api/settings' });
      assert.equal(initial.statusCode, 200);
      assert.equal(initial.json<{ defaultWorkspacePath: string }>().defaultWorkspacePath, '');

      const updated = await app.inject({
        method: 'PUT', url: '/api/settings', headers: json,
        payload: { defaultWorkspacePath: 'D:/workspace/projects' }
      });
      assert.equal(updated.statusCode, 200);
      assert.equal(updated.json<{ defaultWorkspacePath: string }>().defaultWorkspacePath, 'D:/workspace/projects');

      const reread = await app.inject({ method: 'GET', url: '/api/settings' });
      assert.equal(reread.json<{ defaultWorkspacePath: string }>().defaultWorkspacePath, 'D:/workspace/projects');

      const invalid = await app.inject({
        method: 'PUT', url: '/api/settings', headers: json,
        payload: { defaultWorkspacePath: 123 }
      });
      assert.equal(invalid.statusCode, 400);
    } finally { cleanup(); }
  });
});

// --- auth (T2-9) -------------------------------------------------------------

describe('project default Session workspace validation', () => {
  it('rejects a Session whose actual directory differs from the project workspace', async () => {
    const { app, cleanup } = await makeApp();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify([
      { id: 'ses_expected', title: 'Expected', directory: 'D:/workspace/project-a', time: { updated: 10 } },
      { id: 'ses_other', title: 'Other', directory: 'D:/workspace/project-b', time: { updated: 20 } }
    ]), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    try {
      const mismatch = await app.inject({
        method: 'POST', url: '/api/projects', headers: json,
        payload: {
          id: 'p-mismatch', name: 'Mismatch', workspacePath: 'D:/workspace/project-a',
          wakeChannel: 'http://127.0.0.1:4096', defaultSessionId: 'ses_other'
        }
      });
      assert.equal(mismatch.statusCode, 400);
      const afterMismatch = await app.inject({ method: 'GET', url: '/api/projects' });
      assert.ok(!afterMismatch.json<{ id: string }[]>().some(project => project.id === 'p-mismatch'));

      const matching = await app.inject({
        method: 'POST', url: '/api/projects', headers: json,
        payload: {
          id: 'p-matching', name: 'Matching', workspacePath: 'D:/workspace/project-a',
          wakeChannel: 'http://127.0.0.1:4096', defaultSessionId: 'ses_expected'
        }
      });
      assert.equal(matching.statusCode, 201);
      assert.equal(matching.json<{ defaultSessionId: string }>().defaultSessionId, 'ses_expected');
    } finally {
      globalThis.fetch = originalFetch;
      cleanup();
    }
  });
});

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

describe('authenticated comment author', () => {
  it('uses the logged-in username instead of a client-supplied author', async () => {
    const { app, store, cleanup } = await makeApp({ TASKBOARD_HOST: '0.0.0.0' });
    try {
      const setup = await app.inject({
        method: 'POST', url: '/api/auth/setup', headers: json,
        payload: { username: 'jerry', password: 'correct horse battery staple' }
      });
      assert.equal(setup.statusCode, 201);
      const setupHeader = setup.headers['set-cookie'];
      const setupCookie = (Array.isArray(setupHeader) ? setupHeader[0] : setupHeader) ?? '';
      const cookie = setupCookie.split(';')[0];
      assert.ok(cookie);

      const project = await app.inject({
        method: 'POST', url: '/api/projects', headers: { ...json, cookie },
        payload: { id: 'p1', name: 'P' }
      });
      assert.equal(project.statusCode, 201);

      const issue = await app.inject({
        method: 'POST', url: '/api/projects/p1/issues',
        headers: { ...json, cookie, 'x-taskboard-actor': 'cli' },
        payload: { title: 'Authenticated comment test' }
      });
      assert.equal(issue.statusCode, 201);
      const issueId = issue.json<{ id: string }>().id;

      const created = await app.inject({
        method: 'POST', url: `/api/issues/${issueId}/comments`,
        headers: { ...json, cookie, 'x-taskboard-actor': 'web' },
        payload: { author: 'web', body: 'hello from the session user' }
      });
      assert.equal(created.statusCode, 201);
      const comment = created.json<{ id: string; author: string }>();
      assert.equal(comment.author, 'jerry', 'authenticated username must override the submitted author');

      const edited = await app.inject({
        method: 'PATCH', url: `/api/comments/${comment.id}`,
        headers: { ...json, cookie, 'x-taskboard-actor': 'web' },
        payload: { body: 'edited by jerry' }
      });
      assert.equal(edited.statusCode, 200);
      assert.equal(edited.json<{ author: string; body: string }>().author, 'jerry');
      assert.equal(edited.json<{ author: string; body: string }>().body, 'edited by jerry');
      assert.ok(store.listActivities(issueId).some(activity => activity.actor === 'jerry' && activity.action === 'commented'));

      const withoutSession = await app.inject({
        method: 'POST', url: `/api/issues/${issueId}/comments`,
        headers: { ...json, 'x-taskboard-actor': 'web' },
        payload: { author: 'jerry', body: 'attempt without a session' }
      });
      assert.equal(withoutSession.statusCode, 401);
    } finally {
      cleanup();
    }
  });
});

describe('browser admin session auth', () => {
  it('requires a one-time admin setup on non-loopback binds, then uses HttpOnly sessions', async () => {
    const { app, cleanup } = await makeApp({ TASKBOARD_HOST: '0.0.0.0' });
    try {
      const status = await app.inject({ method: 'GET', url: '/api/auth/status' });
      assert.deepEqual(status.json(), {
        authRequired: true, initialized: false, authenticated: false, username: null
      });

      const blocked = await app.inject({ method: 'GET', url: '/api/meta' });
      assert.equal(blocked.statusCode, 401);
      assert.equal(blocked.json<{ code: string }>().code, 'AUTH_REQUIRED');

      const setup = await app.inject({
        method: 'POST', url: '/api/auth/setup', headers: json,
        payload: { username: 'admin', password: 'correct horse battery staple' }
      });
      assert.equal(setup.statusCode, 201);
      const setCookieHeader = setup.headers['set-cookie'];
      const setCookie = (Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader) ?? '';
      assert.match(setCookie, /taskboard_session=/);
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Strict/);
      const cookie = setCookie.split(';')[0];
      assert.ok(cookie);

      const accepted = await app.inject({ method: 'GET', url: '/api/meta', headers: { cookie } });
      assert.equal(accepted.statusCode, 200);

      const duplicateSetup = await app.inject({
        method: 'POST', url: '/api/auth/setup', headers: json,
        payload: { username: 'another', password: 'another secure password' }
      });
      assert.equal(duplicateSetup.statusCode, 409);

      const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
      assert.equal(logout.statusCode, 200);
      const blockedAfterLogout = await app.inject({ method: 'GET', url: '/api/meta', headers: { cookie } });
      assert.equal(blockedAfterLogout.statusCode, 401);

      const wrongPassword = await app.inject({
        method: 'POST', url: '/api/auth/login', headers: json,
        payload: { username: 'admin', password: 'wrong password' }
      });
      assert.equal(wrongPassword.statusCode, 401);

      const login = await app.inject({
        method: 'POST', url: '/api/auth/login', headers: json,
        payload: { username: 'admin', password: 'correct horse battery staple' }
      });
      assert.equal(login.statusCode, 200);
      const loginHeader = login.headers['set-cookie'];
      const loginSetCookie = (Array.isArray(loginHeader) ? loginHeader[0] : loginHeader) ?? '';
      const loginCookie = loginSetCookie.split(';')[0];
      assert.ok(loginCookie);
      const acceptedAfterLogin = await app.inject({ method: 'GET', url: '/api/meta', headers: { cookie: loginCookie } });
      assert.equal(acceptedAfterLogin.statusCode, 200);
    } finally {
      cleanup();
    }
  });

  it('keeps loopback development frictionless when token auth is not configured', async () => {
    const { app, cleanup } = await makeApp({});
    try {
      const status = await app.inject({ method: 'GET', url: '/api/auth/status' });
      assert.equal(status.json<{ authRequired: boolean }>().authRequired, false);
      const meta = await app.inject({ method: 'GET', url: '/api/meta' });
      assert.equal(meta.statusCode, 200);
    } finally {
      cleanup();
    }
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

  it('claim sessionId cannot bypass the Project default Session requirement', async () => {
    const t = await gated();
    const bare = await t.app.inject({ method: 'POST', url: `/api/issues/${t.issueId}/claim`, headers: json, payload: { agent: 'bot' } });
    assert.equal(bare.statusCode, 403);
    assert.match(bare.json<{ error: string }>().error, /Project default Session/);

    const fakeBinding = await t.app.inject({
      method: 'POST', url: `/api/issues/${t.issueId}/claim`, headers: json,
      payload: { agent: 'bot', sessionId: 'ses_forged', branch: 'feat/x' }
    });
    assert.equal(fakeBinding.statusCode, 403, 'task-level sessionId must not override a missing project binding');

    t.store.updateProject('p1', { defaultSessionId: 'ses_project' });
    const claimed = await t.app.inject({
      method: 'POST', url: `/api/issues/${t.issueId}/claim`, headers: json,
      payload: { agent: 'bot', sessionId: 'ses_other', branch: 'feat/x' }
    });
    assert.equal(claimed.statusCode, 200);
    assert.equal(claimed.json<{ sessionId: string; branch: string }>().sessionId, 'ses_project');
    assert.equal(claimed.json<{ branch: string }>().branch, 'feat/x');
    t.cleanup();
  });

  it('PATCH Session values cannot bypass the Project gate; the task inherits once Project is configured', async () => {
    const t = await gated();
    const noProjectSession = await t.app.inject({
      method: 'PATCH', url: `/api/issues/${t.issueId}`, headers: json,
      payload: {
        status: 'in_progress', sessionId: 'ses_forged', branch: 'feat/z',
        statusNote: '开始执行：准备工作已完成。验证证据：权限门禁检查完成。未覆盖：实现尚未完成。',
        version: 1
      }
    });
    assert.equal(noProjectSession.statusCode, 403);
    assert.match(noProjectSession.json<{ error: string }>().error, /Project default Session/);

    t.store.updateProject('p1', { defaultSessionId: 'ses_project' });
    const allowed = await t.app.inject({
      method: 'PATCH', url: `/api/issues/${t.issueId}`, headers: json,
      payload: {
        status: 'in_progress', branch: 'feat/z',
        statusNote: '开始执行：准备工作已完成。验证证据：项目会话继承已确认。未覆盖：实现尚未完成。',
        version: 1
      }
    });
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.equal(allowed.json<{ sessionId: string }>().sessionId, 'ses_project');
    t.cleanup();
  });

  it('web actor is exempt; disabled env restores old behavior', async () => {
    const t = await gated();
    const web = await t.app.inject({
      method: 'PATCH', url: `/api/issues/${t.issueId}`,
      headers: { ...json, 'x-taskboard-actor': 'web' },
      payload: { status: 'in_progress', version: 1 }
    });
    assert.equal(web.statusCode, 200, 'web is exempt');
    t.app.close();

    const app2 = await makeApp({ TASKBOARD_REQUIRE_SESSION: '0' });
    await seedProject(app2.app);
    const id2 = await seedIssue(app2.app);
    const claim2 = await app2.app.inject({
      method: 'POST', url: `/api/issues/${id2}/claim`, headers: json, payload: { agent: 'bot' }
    });
    assert.equal(claim2.statusCode, 200, 'opt-out restores open flow');
    app2.cleanup();
  });
});
describe('workspace directory API', () => {
  it('creates a directory default workspace path and lets projects inherit it', async () => {
    const { app, cleanup } = await makeApp();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify([
      { id: 'ses_a', title: 'Project A', directory: '/workspace/a', time: { updated: 1 } }
    ]), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    try {
      const directoryRes = await app.inject({
        method: 'POST', url: '/api/directories', headers: json,
        payload: { name: 'Workspace A', workspacePath: '/workspace/a', serverUrl: 'http://127.0.0.1:4096' }
      });
      assert.equal(directoryRes.statusCode, 201);
      const directory = directoryRes.json<{ id: string; workspacePath: string }>();
      assert.equal(directory.workspacePath, '/workspace/a');
      const projectRes = await app.inject({
        method: 'POST', url: '/api/projects', headers: json,
        payload: { name: 'Project A', directoryId: directory.id, defaultSessionId: 'ses_a' }
      });
      assert.equal(projectRes.statusCode, 201);
      const project = projectRes.json<{ directoryId: string; defaultSessionId: string; workspacePath: string; wakeChannel: string }>();
      assert.equal(project.directoryId, directory.id);
      assert.equal(project.defaultSessionId, 'ses_a');
      assert.equal(project.workspacePath, '/workspace/a');
      assert.equal(project.wakeChannel, 'http://127.0.0.1:4096');
    } finally {
      globalThis.fetch = originalFetch;
      cleanup();
    }
  });

  it('directory routing changes update every Project and clear inherited Session bindings', async () => {
    const { app, store, cleanup } = await makeApp();
    try {
      const created = await app.inject({
        method: 'POST', url: '/api/directories', headers: json,
        payload: { name: 'Sync workspace', workspacePath: '/workspace/old', serverUrl: 'http://127.0.0.1:4096' }
      });
      const directoryId = created.json<{ id: string }>().id;
      const projectRes = await app.inject({
        method: 'POST', url: '/api/projects', headers: json,
        payload: { name: 'Project A', directoryId, defaultSessionId: null }
      });
      assert.equal(projectRes.statusCode, 201, projectRes.body);
      const projectId = projectRes.json<{ id: string }>().id;
      store.updateProject(projectId, { defaultSessionId: 'ses-old' });
      const issueRes = await app.inject({
        method: 'POST', url: `/api/projects/${projectId}/issues`, headers: json,
        payload: { title: 'Inherited session' }
      });
      assert.equal(issueRes.statusCode, 201, issueRes.body);
      const issueId = issueRes.json<{ id: string }>().id;

      const changed = await app.inject({
        method: 'PATCH', url: `/api/directories/${directoryId}`, headers: json,
        payload: { workspacePath: '/workspace/new', serverUrl: 'http://127.0.0.1:4097' }
      });
      assert.equal(changed.statusCode, 200, changed.body);
      const projectAfter = (await app.inject({
        method: 'GET', url: `/api/projects/${projectId}`
      })).json<{ workspacePath: string; wakeChannel: string; defaultSessionId: string | null }>();
      assert.equal(projectAfter.workspacePath, '/workspace/new');
      assert.equal(projectAfter.wakeChannel, 'http://127.0.0.1:4097');
      assert.equal(projectAfter.defaultSessionId, null);
      const issueAfter = (await app.inject({
        method: 'GET', url: `/api/issues/${issueId}`
      })).json<{ sessionId: string | null; activities: { action: string }[] }>();
      assert.equal(issueAfter.sessionId, null);
      assert.ok(issueAfter.activities.some(activity => activity.action === 'session-unbound'));
    } finally { cleanup(); }
  });

  it('exposes OpenCode status from the Directory menu endpoint', async () => {
    const { app, cleanup } = await makeApp();
    try {
      const created = await app.inject({
        method: 'POST', url: '/api/directories', headers: json,
        payload: { name: 'Unconfigured workspace' }
      });
      const id = created.json<{ id: string }>().id;
      const res = await app.inject({ method: 'GET', url: `/api/directories/${id}/opencode-status` });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json<{ serverStatus: string }>().serverStatus, 'unconfigured');
      assert.deepEqual(res.json<{ projects: unknown[] }>().projects, []);
    } finally { cleanup(); }
  });

  it('projects inherit routing from the Directory and directory deletion can cascade', async () => {
    const { app, cleanup } = await makeApp();
    const created = await app.inject({
      method: 'POST', url: '/api/directories', headers: json,
      payload: { name: 'Workspace', workspacePath: '/workspace', serverUrl: 'http://127.0.0.1:4096' }
    });
    const directoryId = created.json<{ id: string }>().id;
    const project = await app.inject({
      method: 'POST', url: '/api/projects', headers: json,
      payload: { name: 'Project', directoryId }
    });
    assert.equal(project.statusCode, 201, project.body);
    const projectId = project.json<{ id: string }>().id;
    const rejectedProjectPatch = await app.inject({
      method: 'PATCH', url: `/api/projects/${projectId}`, headers: json,
      payload: { workspacePath: '/workspace/renamed', wakeChannel: 'http://127.0.0.1:4097' }
    });
    assert.equal(rejectedProjectPatch.statusCode, 400, 'Project API does not accept route overrides');
    const updated = await app.inject({
      method: 'PATCH', url: `/api/directories/${directoryId}`, headers: json,
      payload: { workspacePath: '/workspace/renamed', serverUrl: 'http://127.0.0.1:4097' }
    });
    assert.equal(updated.statusCode, 200, updated.body);
    const projectAfter = (await app.inject({ method: 'GET', url: `/api/projects/${projectId}` })).json<{ workspacePath: string; wakeChannel: string }>();
    assert.equal(projectAfter.workspacePath, '/workspace/renamed');
    assert.equal(projectAfter.wakeChannel, 'http://127.0.0.1:4097');

    const issue = await app.inject({
      method: 'POST', url: `/api/projects/${projectId}/issues`,
      headers: { ...json, 'x-taskboard-actor': 'cli' }, payload: { title: 'cascade me' }
    });
    assert.equal(issue.statusCode, 201);
    const issueId = issue.json<{ id: string }>().id;

    const blocked = await app.inject({ method: 'DELETE', url: `/api/directories/${directoryId}` });
    assert.equal(blocked.statusCode, 400);

    const deletion = await app.inject({ method: 'DELETE', url: `/api/directories/${directoryId}?cascade=1` });
    assert.equal(deletion.statusCode, 200, deletion.body);
    assert.equal((await app.inject({ method: 'GET', url: `/api/projects/${projectId}` })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: `/api/issues/${issueId}` })).statusCode, 404);
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
describe('web-created tasks inherit Project Session', () => {
  it('rejects missing Project Session even when a legacy task sessionId is supplied', async () => {
    const { app, store, cleanup } = await makeApp();
    await seedProject(app);
    const missing = await app.inject({
      method: 'POST', url: '/api/projects/p1/issues',
      headers: { ...json, 'x-taskboard-actor': 'web' },
      payload: { title: 'must bind' }
    });
    assert.equal(missing.statusCode, 400);
    assert.match(missing.json<{ error: string }>().error, /项目配置默认 OpenCode Session/);

    const forged = await app.inject({
      method: 'POST', url: '/api/projects/p1/issues',
      headers: { ...json, 'x-taskboard-actor': 'web' },
      payload: { title: 'legacy forged', sessionId: 'ses_existing' }
    });
    assert.equal(forged.statusCode, 400, 'a task-level Session must not satisfy the Project gate');

    store.updateProject('p1', { defaultSessionId: 'ses_project' });
    const inherited = await app.inject({
      method: 'POST', url: '/api/projects/p1/issues',
      headers: { ...json, 'x-taskboard-actor': 'web' },
      payload: { title: 'inherits project', sessionId: 'ses_other' }
    });
    assert.equal(inherited.statusCode, 201, inherited.body);
    assert.equal(inherited.json<{ sessionId: string }>().sessionId, 'ses_project');
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
    const projectSessionApp = await gated();
    projectSessionApp.store.updateProject('p1', { defaultSessionId: 'ses_web' });
    const create = await projectSessionApp.app.inject({
      method: 'POST', url: '/api/projects/p1/issues',
      headers: { ...json, 'x-taskboard-actor': 'web' }, payload: { title: 't', status: 'done', sessionId: 'ses_other' }
    });
    assert.equal(patch.statusCode, 200);
    assert.equal(create.statusCode, 201, create.body);
    assert.equal(create.json<{ sessionId: string }>().sessionId, 'ses_web');
    projectSessionApp.cleanup();
    cleanup();
  });

  it('does not treat confirm:true as human approval on either path', async () => {
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
    assert.equal(patch.statusCode, 403);
    assert.equal(create.statusCode, 403);
    cleanup();
  });

  it('never gates non-done statuses', async () => {
    const { app, cleanup, issueId } = await gated();
    const v = (await app.inject({ method: 'GET', url: `/api/issues/${issueId}` })).json<{ version: number }>().version;
    const res = await app.inject({
      method: 'PATCH', url: `/api/issues/${issueId}`,
      headers: { ...json, 'x-taskboard-actor': 'cli' }, payload: { status: 'in_progress', statusNote: '开始执行：准备工作已完成。验证证据：会话和分支已确认。未覆盖：任务实现尚未开始。', version: v }
    });
    assert.equal(res.statusCode, 200);
    cleanup();
  });
});

describe('claim endpoints (lease + inherited Session)', () => {
  it('claim cannot override the Project Session and auto-flows todo → in_progress', async () => {
    const { app, store, cleanup } = await makeApp();
    await seedProject(app);
    store.updateProject('p1', { defaultSessionId: 'ses_project' });
    const issueId = await seedIssue(app);
    const res = await app.inject({
      method: 'POST', url: `/api/issues/${issueId}/claim`, headers: json,
      payload: { agent: 'sisyphus', sessionId: 'ses_forged' }
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ status: string; sessionId: string | null; claimedBy: string }>();
    assert.equal(body.status, 'in_progress', '认领即开工');
    assert.equal(body.sessionId, 'ses_project', '认领 Session is projected from Project');
    assert.equal(body.claimedBy, 'sisyphus');
    cleanup();
  });

  it('task-level Session PATCH and claim fields never replace the Project binding', async () => {
    const { app, store, cleanup } = await makeApp();
    await seedProject(app);
    store.updateProject('p1', { defaultSessionId: 'ses_project' });
    const issueId = await seedIssue(app);
    const patched = await app.inject({
      method: 'PATCH', url: `/api/issues/${issueId}`, headers: json,
      payload: { sessionId: 'ses_owner' }
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json<{ sessionId: string | null }>().sessionId, 'ses_project');
    const res = await app.inject({
      method: 'POST', url: `/api/issues/${issueId}/claim`, headers: json,
      payload: { agent: 'intruder', sessionId: 'ses_intruder' }
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json<{ sessionId: string | null }>().sessionId, 'ses_project');
    cleanup();
  });

  it('served openapi documents ClaimRequest.sessionId (legacy input is ignored by Session ownership)', async () => {
    const { app, cleanup } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/openapi.json' });
    const spec = res.json<{ components: { schemas: { ClaimRequest: { properties: Record<string, unknown> } } } }>();
    assert.ok(spec.components.schemas.ClaimRequest.properties.sessionId);
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

    // 完成任务必须走 web 审批入口，客户端自报 confirm 不能绕过门禁。
    const doneVersion = (await app.inject({ method: 'GET', url: `/api/issues/${a}` })).json<{ version: number }>().version;
    const done = await app.inject({ method: 'PATCH', url: `/api/issues/${a}`, headers: { ...json, 'x-taskboard-actor': 'web' }, payload: { status: 'done', version: doneVersion } });
    assert.equal(done.statusCode, 200);
    const after = await app.inject({ method: 'GET', url: '/api/projects/p1/next' });
    assert.equal(after.json<{ issue: { id: string } | null }>().issue?.id, b);
    cleanup();
  });
});

describe('status transition audit-note gate', () => {
  it('rejects an agent transition without statusNote even when the agent already commented', async () => {
    const { app, cleanup } = await makeApp();
    await seedProject(app);
    const issueId = await seedIssue(app);
    await app.inject({
      method: 'POST', url: `/api/issues/${issueId}/comments`,
      headers: { ...json, 'x-taskboard-actor': 'cli' },
      payload: { author: 'cli', body: '以前留过的评论不能替代本次变更说明' }
    });
    const before = (await app.inject({ method: 'GET', url: `/api/issues/${issueId}` })).json<any>();
    const res = await app.inject({
      method: 'PATCH', url: `/api/issues/${issueId}`,
      headers: { ...json, 'x-taskboard-actor': 'cli' },
      payload: { status: 'in_review', version: before.version }
    });
    assert.equal(res.statusCode, 403);
    assert.match(res.json<{ error: string }>().error, /statusNote/);
    const after = (await app.inject({ method: 'GET', url: `/api/issues/${issueId}` })).json<any>();
    assert.equal(after.status, 'todo', 'a rejected transition must not change status');
    assert.equal(after.comments.length, before.comments.length, 'a rejected transition must not create a comment');
    cleanup();
  });

  it('atomically stores an agent status transition and its audit comment', async () => {
    const { app, cleanup } = await makeApp();
    await seedProject(app);
    const issueId = await seedIssue(app);
    const before = (await app.inject({ method: 'GET', url: `/api/issues/${issueId}` })).json<any>();
    const note = '原因：实现与自测已完成。验证证据：prettier、eslint 通过。未覆盖：1366/1920 目验与 vue-tsc。';
    const res = await app.inject({
      method: 'PATCH', url: `/api/issues/${issueId}`,
      headers: { ...json, 'x-taskboard-actor': 'codex' },
      payload: { status: 'in_review', statusNote: note, version: before.version }
    });
    assert.equal(res.statusCode, 200);
    const after = (await app.inject({ method: 'GET', url: `/api/issues/${issueId}` })).json<any>();
    assert.equal(after.status, 'in_review');
    assert.equal(after.version, before.version + 1);
    const audit = after.comments.find((comment: any) => comment.body.includes('状态变更记录：todo → in_review'));
    assert.ok(audit, 'transition comment should be committed with the status');
    assert.equal(audit.author, 'codex');
    assert.ok(audit.body.includes('prettier、eslint 通过'));
    assert.ok(audit.body.includes('未覆盖：1366/1920 目验与 vue-tsc'));
    cleanup();
  });

  it('automatically records web transitions and does not duplicate comments on no-op status writes', async () => {
    const { app, cleanup } = await makeApp();
    await seedProject(app);
    const issueId = await seedIssue(app);
    const first = await app.inject({
      method: 'PATCH', url: `/api/issues/${issueId}`,
      headers: { ...json, 'x-taskboard-actor': 'web' },
      payload: { status: 'in_review', version: 1 }
    });
    assert.equal(first.statusCode, 200);
    const afterFirst = (await app.inject({ method: 'GET', url: `/api/issues/${issueId}` })).json<any>();
    assert.equal(afterFirst.comments.length, 1);
    assert.equal(afterFirst.comments[0].author, 'web');
    assert.match(afterFirst.comments[0].body, /todo → in_review/);
    assert.match(afterFirst.comments[0].body, /未提供额外说明/);

    const noOp = await app.inject({
      method: 'PATCH', url: `/api/issues/${issueId}`,
      headers: { ...json, 'x-taskboard-actor': 'cli' },
      payload: { status: 'in_review', version: afterFirst.version }
    });
    assert.equal(noOp.statusCode, 200, 're-affirming a status is not a transition');
    const afterNoOp = (await app.inject({ method: 'GET', url: `/api/issues/${issueId}` })).json<any>();
    assert.equal(afterNoOp.comments.length, 1, 'no-op status writes must not duplicate audit comments');
    cleanup();
  });

  it('statusNote gate cannot be disabled by TASKBOARD_REVIEW_COMMENT=0', async () => {
    const { app, cleanup } = await makeApp({ TASKBOARD_REVIEW_COMMENT: '0' });
    await seedProject(app);
    const issueId = await seedIssue(app);
    const res = await app.inject({
      method: 'PATCH', url: `/api/issues/${issueId}`,
      headers: { ...json, 'x-taskboard-actor': 'cli' },
      payload: { status: 'in_review', version: 1 }
    });
    assert.equal(res.statusCode, 403);
    assert.match(res.json<{ error: string }>().error, /statusNote/);
    cleanup();
  });

  it('keeps web UI transitions convenient and preserves the create-at-in_review gate', async () => {
    const { app, cleanup } = await makeApp();
    await seedProject(app);
    const issueId = await seedIssue(app);
    const webPatch = await app.inject({
      method: 'PATCH', url: `/api/issues/${issueId}`,
      headers: { ...json, 'x-taskboard-actor': 'web' }, payload: { status: 'in_review', version: 1 }
    });
    assert.equal(webPatch.statusCode, 200);
    const create = await app.inject({
      method: 'POST', url: '/api/projects/p1/issues', headers: json,
      payload: { title: '直接交验', status: 'in_review' }
    });
    assert.equal(create.statusCode, 403);
    cleanup();
  });
});

describe('server bind safety', () => {
  it('requires administrator initialization for non-loopback binds without a machine token', async () => {
    const { app, cleanup } = await makeApp({ TASKBOARD_HOST: '0.0.0.0' });
    try {
      const status = await app.inject({ method: 'GET', url: '/api/auth/status' });
      assert.equal(status.json<{ authRequired: boolean; initialized: boolean }>().authRequired, true);
      assert.equal(status.json<{ authRequired: boolean; initialized: boolean }>().initialized, false);
      const response = await app.inject({ method: 'GET', url: '/api/meta' });
      assert.equal(response.statusCode, 401);
    } finally {
      cleanup();
    }
  });

  it('allows loopback binding without a token for local-only use', async () => {
    const { app, cleanup } = await makeApp({ TASKBOARD_HOST: '127.0.0.1' });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/meta' });
      assert.equal(response.statusCode, 200);
    } finally {
      cleanup();
    }
  });

  it('allows non-loopback binding when an API token is configured', async () => {
    const { app, cleanup } = await makeApp({ TASKBOARD_HOST: '0.0.0.0', TASKBOARD_TOKEN: 'test-token' });
    try {
      const response = await app.inject({
        method: 'GET', url: '/api/meta',
        headers: { authorization: 'Bearer test-token' }
      });
      assert.equal(response.statusCode, 200);
    } finally {
      cleanup();
    }
  });
});


describe('Directory routing safety', () => {
  it('rejects inherited workspace/server changes while an Agent holds an active lease', async () => {
    const { app, store, cleanup } = await makeApp();
    try {
      await seedProject(app);
      store.updateProject('p1', { defaultSessionId: 'ses_a' });
      const issueId = await seedIssue(app, {}, 'agent-a');
      const projectBefore = (await app.inject({ method: 'GET', url: '/api/projects/p1' })).json<{ directoryId: string }>();
      const claim = await app.inject({
        method: 'POST', url: `/api/issues/${issueId}/claim`, headers: json,
        payload: { agent: 'agent-a', sessionId: 'ses_a', branch: 'feat/task-a', ttlMinutes: 30 }
      });
      assert.equal(claim.statusCode, 200);

      const changed = await app.inject({
        method: 'PATCH', url: `/api/directories/${projectBefore.directoryId}`, headers: json,
        payload: { workspacePath: '/workspace/other', serverUrl: 'http://127.0.0.1:4097' }
      });
      assert.equal(changed.statusCode, 409, changed.body);
      assert.match(changed.json<{ error: string }>().error, /active agent leases/);

      const project = await app.inject({ method: 'GET', url: '/api/projects/p1' });
      assert.equal(project.json<{ workspacePath: string }>().workspacePath, '');
    } finally {
      cleanup();
    }
  });
});

describe('task Git worktree creation', () => {
  it('creates and binds an isolated worktree, and retries idempotently', async () => {
    const { app, cleanup } = await makeApp();
    const root = mkdtempSync(join(tmpdir(), 'tb-worktree-test-'));
    const workspacePath = join(root, 'repo');
    mkdirSync(workspacePath);
    const git = (args: string[]) => execFileSync('git', args, { cwd: workspacePath, stdio: 'pipe' });
    try {
      git(['init', '-b', 'main']);
      git(['config', 'user.email', 'taskboard-test@example.invalid']);
      git(['config', 'user.name', 'Taskboard Test']);
      writeFileSync(join(workspacePath, 'README.md'), 'seed\n');
      git(['add', 'README.md']);
      git(['commit', '-m', 'initial commit']);

      const project = await app.inject({
        method: 'POST', url: '/api/projects', headers: json,
        payload: { id: 'git-project', name: 'Git project', workspacePath }
      });
      assert.equal(project.statusCode, 201);

      const conflictIssue = await app.inject({
        method: 'POST', url: '/api/projects/git-project/issues', headers: json,
        payload: { title: 'Conflict task' }
      });
      const conflictId = conflictIssue.json<{ id: string }>().id;
      const conflictBranch = `task/${conflictId}-conflict-task`;
      git(['branch', conflictBranch]);
      const conflict = await app.inject({
        method: 'POST', url: `/api/issues/${conflictId}/create-worktree`,
        headers: { 'x-taskboard-actor': 'web' }
      });
      assert.equal(conflict.statusCode, 409);
      assert.match(conflict.json<{ error: string }>().error, /分支已存在/);

      const issue = await app.inject({
        method: 'POST', url: '/api/projects/git-project/issues', headers: json,
        payload: { title: 'Implement calendar view', sessionId: 'ses_main_checkout' }
      });
      assert.equal(issue.statusCode, 201);
      const issueId = issue.json<{ id: string }>().id;

      const created = await app.inject({
        method: 'POST', url: `/api/issues/${issueId}/create-worktree`,
        headers: { 'x-taskboard-actor': 'web' }
      });
      assert.equal(created.statusCode, 201, created.body);
      const body = created.json<{ branch: string; worktree: string; worktreePath: string; alreadyBound: boolean; issue: { branch: string; worktreePath: string } }>();
      assert.equal(body.alreadyBound, false);
      assert.ok(body.branch.startsWith('task/'));
      assert.equal(body.issue.branch, body.branch);
      assert.equal(body.issue.worktreePath, body.worktreePath);
      assert.equal(body.issue.sessionId, null, 'a session bound to the main checkout must be cleared after creating a worktree');
      assert.ok(existsSync(body.worktreePath));
      assert.doesNotThrow(() => git(['show-ref', '--verify', `refs/heads/${body.branch}`]));

      const retry = await app.inject({
        method: 'POST', url: `/api/issues/${issueId}/create-worktree`,
        headers: { 'x-taskboard-actor': 'web' }
      });
      assert.equal(retry.statusCode, 200, retry.body);
      assert.equal(retry.json<{ alreadyBound: boolean }>().alreadyBound, true);

      const released = await app.inject({
        method: 'DELETE', url: `/api/issues/${issueId}/git-binding`,
        headers: { 'x-taskboard-actor': 'web' }
      });
      assert.equal(released.statusCode, 200, released.body);
      assert.equal(released.json<{ branch: string; worktree: string; worktreePath: string }>().branch, '');
      assert.equal(released.json<{ branch: string; worktree: string; worktreePath: string }>().worktree, '');
      assert.equal(released.json<{ branch: string; worktree: string; worktreePath: string }>().worktreePath, '');
      assert.ok(existsSync(body.worktreePath), 'unbind must not delete the local worktree');
    } finally {
      cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns a clear client error when the project has no Git workspace', async () => {
    const { app, cleanup } = await makeApp();
    try {
      await seedProject(app);
      const issueId = await seedIssue(app);
      const response = await app.inject({
        method: 'POST', url: `/api/issues/${issueId}/create-worktree`,
        headers: json, payload: {}
      });
      assert.equal(response.statusCode, 400);
      assert.match(response.json<{ error: string }>().error, /工作目录/);
    } finally {
      cleanup();
    }
  });
});

describe('task-level OpenCode Session creation is removed', () => {
  it('rejects the obsolete endpoint; Sessions are configured on Project only', async () => {
    const { app, cleanup } = await makeApp();
    try {
      await seedProject(app);
      const issueId = await seedIssue(app);
      const response = await app.inject({
        method: 'POST', url: `/api/issues/${issueId}/opencode-session`,
        headers: { 'x-taskboard-actor': 'web' }
      });
      assert.equal(response.statusCode, 404);
    } finally {
      cleanup();
    }
  });
});

describe('Agent execution event timeline', () => {
  it('persists queued, retry and failure events on the task detail', async () => {
    const { app, cleanup } = await makeApp();
    try {
      await seedProject(app);
      const issueId = await seedIssue(app);
      const report = async (outcome: string, detail: string) => app.inject({
        method: 'POST', url: `/api/issues/${issueId}/agent-events`,
        headers: { ...json, 'x-taskboard-actor': 'watch' },
        payload: { outcome, detail }
      });
      assert.equal((await report('queued', 'prompt submitted')).statusCode, 201);
      assert.equal((await report('running', 'session reports busy')).statusCode, 201);
      assert.equal((await report('idle', 'session reports idle; not task success')).statusCode, 201);
      assert.equal((await report('retrying', 'attempt 1 failed')).statusCode, 201);
      assert.equal((await report('failed', 'all attempts failed')).statusCode, 201);
      const detail = await app.inject({ method: 'GET', url: `/api/issues/${issueId}` });
      const events = detail.json<{ activities: { action: string; detail: string }[] }>().activities
        .filter(activity => activity.action === 'execution');
      assert.equal(events.length, 5);
      assert.ok(events[0]!.detail.includes('[failed] all attempts failed'));
      assert.ok(events[1]!.detail.includes('[retrying] attempt 1 failed'));
      assert.ok(events.some(event => event.detail.includes('[running] session reports busy')));
      assert.ok(events.some(event => event.detail.includes('[idle] session reports idle; not task success')));
    } finally {
      cleanup();
    }
  });

  it('rejects invalid outcomes and empty details', async () => {
    const { app, cleanup } = await makeApp();
    try {
      await seedProject(app);
      const issueId = await seedIssue(app);
      const response = await app.inject({
        method: 'POST', url: `/api/issues/${issueId}/agent-events`,
        headers: json, payload: { outcome: 'maybe', detail: '' }
      });
      assert.equal(response.statusCode, 400);
    } finally {
      cleanup();
    }
  });
});

