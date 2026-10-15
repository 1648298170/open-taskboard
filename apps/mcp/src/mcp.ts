#!/usr/bin/env node
// MCP server for opencode-taskboard (stdio, JSON-RPC 2.0).
// Stateless translation layer forwarding to the local taskboard HTTP service.
// Auto-starts the service via @taskboard/server when it is not running.
import { spawn, ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SERVER_JS = require.resolve('@taskboard/server'); // -> apps/server/dist/server.js
const base = (): string => process.env.TASKBOARD_URL || `http://127.0.0.1:${process.env.TASKBOARD_PORT || 47824}`;

async function apiOnce(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(base() + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data;
}

let serverStarter: ChildProcess | null = null;
async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  try {
    return await apiOnce(method, path, body);
  } catch (err) {
    const cause = (err as NodeJS.ErrnoException).cause as NodeJS.ErrnoException | undefined;
    const code = cause?.code;
    if (code === 'ECONNREFUSED' || /fetch failed/i.test(String((err as Error).message))) {
      if (!serverStarter) {
        serverStarter = spawn(process.execPath, [SERVER_JS], {
          stdio: 'ignore', detached: false,
          env: { ...process.env, TASKBOARD_HOST: '127.0.0.1', TASKBOARD_PORT: process.env.TASKBOARD_PORT || '47824' }
        });
        serverStarter.unref();
        await new Promise(r => setTimeout(r, 800));
      }
      return apiOnce(method, path, body);
    }
    throw err;
  }
}

// ---- tool definitions ----
interface Tool { name: string; description: string; inputSchema: Record<string, unknown> }

const TOOLS: Tool[] = [
  { name: 'list_projects', description: '列出任务板上所有项目', inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
  {
    name: 'create_project', description: '创建项目',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { id: { type: 'string' }, name: { type: 'string' }, workspacePath: { type: 'string' } },
      required: ['name']
    }
  },
  {
    name: 'delete_project', description: '删除项目及其全部任务与评论（危险操作）',
    inputSchema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } }, required: ['id'] }
  },
  {
    name: 'list_issues', description: '列出项目下的任务（含子任务）',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        projectId: { type: 'string' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'in_review', 'done'] },
        parentId: { type: ['string', 'null'], description: '只看某父任务的子任务；null 表示只看顶层' }
      },
      required: ['projectId']
    }
  },
  {
    name: 'show_issue', description: '查看任务详情：描述、子任务、评论、版本号',
    inputSchema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } }, required: ['id'] }
  },
  {
    name: 'create_issue',
    description: '创建任务。拆解需求时：先建顶层父任务，再用 parentId 为每个子需求建子任务（仅支持两层）',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        projectId: { type: 'string', description: '项目 ID（必填）' },
        parentId: { type: ['string', 'null'] },
        title: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'in_review', 'done'] },
        priority: { type: 'string', enum: ['urgent', 'high', 'medium', 'low'] },
        labels: { type: 'string' }, branch: { type: 'string' }, assignee: { type: 'string' }
      },
      required: ['projectId', 'title']
    }
  },
  {
    name: 'update_issue',
    description: '更新任务。状态流转 todo → in_progress → in_review → done；done 需用户确认后才能设置。必须带 version（乐观锁，取自 show_issue），冲突时重新读取再试',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'string' },
        version: { type: 'integer', description: '乐观锁：当前版本号' },
        title: { type: 'string' }, description: { type: 'string' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'in_review', 'done'] },
        priority: { type: 'string', enum: ['urgent', 'high', 'medium', 'low'] },
        labels: { type: 'string' }, branch: { type: 'string' }, assignee: { type: 'string' }
      },
      required: ['id', 'version']
    }
  },
  {
    name: 'delete_issue', description: '删除任务（级联删除其子任务与评论）',
    inputSchema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } }, required: ['id'] }
  },
  {
    name: 'add_comment', description: '添加评论，用于记录进展、阻塞、验证方式',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { id: { type: 'string' }, author: { type: 'string' }, body: { type: 'string' } },
      required: ['id', 'body']
    }
  },
  {
    name: 'progress', description: '项目进度。weighted 口径：一个顶层任务 = 一个单位，自身 done 或子任务全 done 即完成',
    inputSchema: { type: 'object', additionalProperties: false, properties: { projectId: { type: 'string' } }, required: ['projectId'] }
  }
];

interface IssueDetail { children?: { description: string }[] }

async function callTool(name: string, args: Record<string, any>): Promise<unknown> {
  switch (name) {
    case 'list_projects': return api('GET', '/api/projects');
    case 'create_project': return api('POST', '/api/projects', { id: args.id, name: args.name, workspacePath: args.workspacePath ?? '' });
    case 'delete_project': return api('DELETE', `/api/projects/${args.id}`);
    case 'list_issues': {
      const qs = new URLSearchParams();
      if (args.status) qs.set('status', args.status);
      if (args.parentId !== undefined) qs.set('parentId', args.parentId ?? 'null');
      return api('GET', `/api/projects/${args.projectId}/issues?${qs}`);
    }
    case 'show_issue': {
      const i = await api('GET', `/api/issues/${args.id}`) as IssueDetail;
      return { ...i, children: i.children?.map(({ description: _d, ...c }) => c) };
    }
    case 'create_issue': return api('POST', `/api/projects/${args.projectId}/issues`, {
      parentId: args.parentId ?? null, title: args.title, description: args.description ?? '',
      status: args.status ?? 'todo', priority: args.priority ?? 'medium',
      labels: args.labels ?? '', branch: args.branch ?? '', assignee: args.assignee ?? ''
    });
    case 'update_issue': {
      const body: Record<string, unknown> = { version: args.version };
      for (const k of ['title', 'description', 'status', 'priority', 'labels', 'branch', 'assignee']) {
        if (args[k] !== undefined) body[k] = args[k];
      }
      return api('PATCH', `/api/issues/${args.id}`, body);
    }
    case 'delete_issue': return api('DELETE', `/api/issues/${args.id}`);
    case 'add_comment': return api('POST', `/api/issues/${args.id}/comments`, { author: args.author ?? 'mcp', body: args.body });
    case 'progress': return api('GET', `/api/projects/${args.projectId}/progress`);
    default: throw new Error(`unknown tool: ${name}`);
  }
}

// ---- JSON-RPC over stdio (newline-delimited) ----
interface RpcMsg { jsonrpc: string; id?: number | string; method?: string; params?: Record<string, any> }

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let idx: number;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) void handle(line).catch(e => process.stderr.write(`mcp: ${e}\n`));
  }
});
process.stdin.on('end', () => process.exit(0));

const send = (msg: unknown): void => { process.stdout.write(JSON.stringify(msg) + '\n'); };

async function handle(line: string): Promise<void> {
  let msg: RpcMsg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0', id, result: {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'opencode-taskboard', version: '0.3.0' }
      }
    });
  }
  if (method?.startsWith('notifications/')) return;
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    try {
      const data = await callTool(params!.name, params!.arguments ?? {});
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] } });
    } catch (err) {
      return send({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: `error: ${(err as Error).message}` }], isError: true }
      });
    }
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
}
