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
    const app = await makeApp({ TASKBOARD_HUMAN_DONE: '1' });
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
      headers: { ...json, 'x-taskboard-actor': 'web' }, payload: { title: 't', status: 'done' }
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

  it('PATCH edits a pending comment and moves its wake status; editing locked states 400s', async () => {
    const { app, cleanup } = await makeApp({});
    await seedProject(app);
    const issueId = await seedIssue(app);
    const created = await app.inject({
      method: 'POST', url: `/api/issues/${issueId}/comments`, headers: json, payload: { author: 'a', body: 'first' }
    });
    const commentId = created.json<{ id: string }>().id;

    const edited = await app.inject({ method: 'PATCH', url: `/api/comments/${commentId}`, headers: json, payload: { body: 'edited' } });
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
