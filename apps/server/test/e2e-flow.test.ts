// API 级 E2E：真实 TCP 监听（非 inject），SSE 流式断言。覆盖完整验收链路——
// 建任务 → @agent 评论（载荷增强经 SSE 实时送达）→ claim（自动流转 + 会话
// 绑定）→ done 门禁（403 → confirm 200）。拦「环节都对、连起来断」的回归。
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '@taskboard/core';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

/** 从 SSE 字节流里等待指定片段出现（超时即断开并报错）。 */
async function waitForSseFragment(
  res: Response, needle: string, controller: AbortController, timeoutMs = 10_000
): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (buf.includes(needle)) {
      controller.abort();
      return buf;
    }
    if (Date.now() > deadline) {
      controller.abort();
      throw new Error(`SSE timeout waiting for: ${needle}\nbuffer: ${buf.slice(-800)}`);
    }
    const { done, value } = await reader.read();
    if (done) throw new Error(`SSE stream ended before: ${needle}`);
    buf += decoder.decode(value, { stream: true });
  }
}

describe('API 级 E2E：验收链路（真实 HTTP + SSE）', () => {
  let app: FastifyInstance;
  let store: Store;
  let baseUrl: string;
  let dir: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tb-e2e-'));
    store = new Store(join(dir, 'board.sqlite'), new DatabaseSync(':memory:'));
    ({ app } = await buildApp({ store, env: { TASKBOARD_BACKUPS: '0' } }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('建任务 → @agent 评论经 SSE 增强载荷实时送达 → claim 继承项目会话并自动流转 → done 门禁 403/403', async () => {
    const json = { 'content-type': 'application/json', 'x-taskboard-actor': 'web' };

    // SSE 订阅先行（真实 TCP 流）
    const controller = new AbortController();
    let sseRes: Response | undefined;
    void fetch(`${baseUrl}/api/events`, {
      signal: controller.signal,
      headers: { accept: 'text/event-stream' }
    }).then(res => { sseRes = res; }).catch(() => {});
    for (let i = 0; i < 50 && sseRes === undefined; i++) await new Promise(r => setTimeout(r, 20));
    assert.ok(sseRes, 'SSE 订阅未就绪');

    // 建项目并配置项目默认 Session，再由 Web 创建继承该会话的任务。
    const projectRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'e2e', name: 'E2E' })
    });
    assert.equal(projectRes.status, 201, await projectRes.clone().text());
    store.updateProject('e2e', { defaultSessionId: 'ses_e2e' });
    const issueRes = await fetch(`${baseUrl}/api/projects/e2e/issues`, {
      method: 'POST', headers: json, body: JSON.stringify({ title: '被唤醒的任务', sessionId: 'ses_e2e' })
    });
    const issueText = await issueRes.text();
    assert.equal(issueRes.status, 201, issueText);
    const issue = JSON.parse(issueText) as { id: string; status: string; version: number };
    assert.equal(issue.status, 'todo');

    // @agent 评论 → SSE 必须实时推来增强载荷（author/body/issueTitle，
    // watch 侧车不回查 API 即可决策唤醒——81af96d1 的 E2E 锚）
    await fetch(`${baseUrl}/api/issues/${issue.id}/comments`, {
      method: 'POST', headers: json, body: JSON.stringify({ author: 'web', body: '@agent 编排此任务' })
    });
    const sseBuf = await waitForSseFragment(sseRes, 'comment.created', controller);
    assert.ok(sseBuf.includes('@agent 编排此任务'), 'SSE 携带评论正文');
    assert.ok(sseBuf.includes('"author":"web"'), 'SSE 携带作者');
    assert.ok(sseBuf.includes('被唤醒的任务'), 'SSE 携带 issueTitle');

    // claim：从项目继承会话 + todo 自动流转 in_progress（认领即开工）
    const claimed = await (await fetch(`${baseUrl}/api/issues/${issue.id}/claim`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'e2e-agent', sessionId: 'ses_e2e' })
    })).json<{ status: string; sessionId: string | null; claimedBy: string }>();
    assert.equal(claimed.status, 'in_progress');
    assert.equal(claimed.sessionId, 'ses_e2e');
    assert.equal(claimed.claimedBy, 'e2e-agent');

    // done 门禁：默认开启——agent 无 confirm 403；客户端 confirm 不再被信任，同样 403
    const v = (await (await fetch(`${baseUrl}/api/issues/${issue.id}`)).json<{ version: number }>()).version;
    const denied = await fetch(`${baseUrl}/api/issues/${issue.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'x-taskboard-actor': 'cli' },
      body: JSON.stringify({ status: 'done', version: v })
    });
    assert.equal(denied.status, 403);
    const accepted = await fetch(`${baseUrl}/api/issues/${issue.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', 'x-taskboard-actor': 'cli' },
      body: JSON.stringify({ status: 'done', version: v, confirm: true })
    });
    assert.equal(accepted.status, 403);

    controller.abort();
  });
});
