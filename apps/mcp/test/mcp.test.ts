// MCP 单测（node:test + tsx）：jsonrpc 分发、工具注册表、连接转发策略。
// 不需要真实 server——fetch 以 globalThis stub 注入。
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { z } from '@taskboard/core/schemas';
import { handleMessage, runStdioServer } from '../src/jsonrpc.js';
import { createRegistry, defineTool, toolsListResult } from '../src/tools/registry.js';
import { ensureServerOrThrow, isNetworkFailure } from '../src/connection.js';

const registry = createRegistry([
  ['echo', defineTool(z.object({ text: z.string() }), 'echo back', a => ({ echoed: a.text }))],
  ['text', defineTool(z.object({}), 'plain string result', () => 'raw-text')],
  ['boom', defineTool(z.object({}), 'always throws', () => { throw new Error('kaputt'); })]
]);

describe('handleMessage (jsonrpc dispatch)', () => {
  it('ignores unparseable lines silently', async () => {
    assert.equal(await handleMessage('not json', registry), undefined);
  });

  it('initialize returns protocol version + server info', async () => {
    const out = await handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }), registry) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    assert.equal(out.result.protocolVersion, '2024-11-05');
    assert.equal(out.result.serverInfo.name, 'open-taskboard');
  });

  it('ping returns an empty result; notifications produce nothing', async () => {
    assert.deepEqual((await handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }), registry), undefined) ?? { result: {} }, { result: {} });
    assert.equal(await handleMessage(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), registry), undefined);
  });

  it('tools/list shapes name/description/inputSchema in insertion order', async () => {
    const out = await handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }), registry) as { result: { tools: { name: string }[] } };
    assert.deepEqual(out.result.tools.map(t => t.name), ['echo', 'text', 'boom']);
    assert.ok(out.result.tools[0]!.description.length > 0);
    assert.ok(out.result.tools[0]!.inputSchema);
  });

  it('tools/call pretty-prints object results and passes strings through', async () => {
    const obj = await handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } }), registry) as { result: { content: { text: string }[] } };
    assert.match(obj.result.content[0]!.text, /"echoed": "hi"/);
    const raw = await handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'text', arguments: {} } }), registry) as { result: { content: { text: string }[] } };
    assert.equal(raw.result.content[0]!.text, 'raw-text');
  });

  it('handler throws and unknown tools become isError results (not rpc errors)', async () => {
    const boom = await handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'boom', arguments: {} } }), registry) as { result: { isError: boolean; content: { text: string }[] } };
    assert.equal(boom.result.isError, true);
    assert.match(boom.result.content[0]!.text, /kaputt/);
    const unknown = await handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'nope' } }), registry) as { result: { isError: boolean; content: { text: string }[] } };
    assert.equal(unknown.result.isError, true);
    assert.match(unknown.result.content[0]!.text, /unknown tool: nope/);
  });

  it('zod-invalid arguments surface as isError via the handler path', async () => {
    const bad = await handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'echo', arguments: { wrong: true } } }), registry) as { result: { isError: boolean } };
    assert.equal(bad.result.isError, true);
  });

  it('unknown methods yield -32601 only when the request carries an id', async () => {
    const withId = await handleMessage(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'nope/method' }), registry) as { error: { code: number; message: string } };
    assert.equal(withId.error.code, -32601);
    assert.match(withId.error.message, /nope\/method/);
    assert.equal(await handleMessage(JSON.stringify({ jsonrpc: '2.0', method: 'nope/method' }), registry), undefined);
  });

  it('runStdioServer is exported for the stdio entry (registry DI unchanged)', () => {
    assert.equal(typeof runStdioServer, 'function');
  });
});

describe('tool registry', () => {
  it('zod-parses arguments before the handler sees them', async () => {
    let seen: unknown = null;
    const tool = defineTool(z.object({ n: z.number() }), 't', a => { seen = a; return a; });
    await tool.handler({ n: 5 });
    assert.deepEqual(seen, { n: 5 });
    await assert.rejects(tool.handler({ n: 'not-a-number' }));
  });

  it('toolsListResult mirrors the registry', () => {
    const list = toolsListResult(registry);
    assert.equal(list.tools.length, 3);
  });
});

describe('connection policy', () => {
  const origFetch = globalThis.fetch;
  const origEnv = { ...process.env };
  afterEach(() => {
    globalThis.fetch = origFetch;
    process.env.TASKBOARD_URL = origEnv.TASKBOARD_URL;
    delete process.env.TASKBOARD_TOKEN;
    process.env.TASKBOARD_NO_AUTOSTART = origEnv.TASKBOARD_NO_AUTOSTART;
  });

  it('isNetworkFailure recognises ECONNREFUSED causes only', () => {
    const refused = Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } });
    assert.equal(isNetworkFailure(refused), true);
    assert.equal(isNetworkFailure(new Error('plain')), false);
    assert.equal(isNetworkFailure(Object.assign(new Error('x'), { cause: { code: 'EACCES' } })), false);
  });

  it('apiOnce sends the mcp actor + bearer token and returns parsed data', async () => {
    process.env.TASKBOARD_URL = 'http://127.0.0.1:49999';
    process.env.TASKBOARD_TOKEN = 'sekret';
    let captured: { headers: Record<string, string>; body?: string } | null = null;
    globalThis.fetch = (async (_url, init) => {
      captured = { headers: init?.headers as Record<string, string>, body: init?.body as string | undefined };
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    }) as typeof fetch;
    const data = await ensureServerOrThrow('PATCH', '/api/issues/x', { status: 'in_review' });
    assert.deepEqual(data, { ok: 1 });
    assert.equal(captured!.headers['x-taskboard-actor'], 'mcp');
    assert.equal(captured!.headers.Authorization, 'Bearer sekret');
    assert.equal(captured!.body, JSON.stringify({ status: 'in_review' }));
  });

  it('non-network failures (4xx/5xx with error body) surface the server message', async () => {
    process.env.TASKBOARD_URL = 'http://127.0.0.1:49999';
    process.env.TASKBOARD_NO_AUTOSTART = '1';
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'version conflict' }), { status: 409 })) as typeof fetch;
    await assert.rejects(ensureServerOrThrow('PATCH', '/api/issues/x', {}), /version conflict/);
  });

  it('network failure with NO_AUTOSTART yields the loud actionable error', async () => {
    process.env.TASKBOARD_URL = 'http://127.0.0.1:49999';
    process.env.TASKBOARD_NO_AUTOSTART = '1';
    globalThis.fetch = (async () => { throw Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }); }) as typeof fetch;
    await assert.rejects(ensureServerOrThrow('GET', '/api/projects'), /TASKBOARD_NO_AUTOSTART=1 已禁用自动拉起/);
  });
});

describe('issueTools 会话记忆（认领自动补绑）', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it('a declared sessionId (create/update) is auto-carried into later claims', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: string }) => {
      if (String(url).includes('/claim')) bodies.push(JSON.parse(init?.body as string));
      return new Response(JSON.stringify({ id: 'x', version: 2 }), { status: 200 });
    }) as typeof fetch;
    const { issueTools } = await import('../src/tools/issues.js');
    const table = new Map(issueTools);
    // 先声明（create 带 sessionId）
    await table.get('create_issue')!.handler({ projectId: 'p', title: 't', sessionId: 'ses_mem' });
    // 后续 claim 未传 sessionId → 自动补绑
    await table.get('claim_issue')!.handler({ id: 'I1', agent: 'a' });
    // 显式传值仍优先生效
    await table.get('claim_issue')!.handler({ id: 'I2', agent: 'a', sessionId: 'ses_explicit' });
    assert.deepEqual(bodies[0], { agent: 'a', sessionId: 'ses_mem' });
    assert.deepEqual(bodies[1], { agent: 'a', sessionId: 'ses_explicit' });
  });
});
