// Transport layer: JSON-RPC 2.0 over stdio, newline-delimited. No tool logic
// lives here — tools arrive via the injected registry (DI); this module only
// frames requests, dispatches methods, and renders responses/error shapes.
import { toolsListResult, type ToolRegistry } from './tools/registry.js';

interface RpcMessage { jsonrpc: string; id?: number | string; method?: string; params?: Record<string, unknown> }

export function runStdioServer(registry: ToolRegistry): void {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) void handle(line, registry).catch(e => process.stderr.write(`mcp: ${e}\n`));
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

const send = (msg: unknown): void => { process.stdout.write(JSON.stringify(msg) + '\n'); };

async function handle(line: string, registry: ToolRegistry): Promise<void> {
  let msg: RpcMessage;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0', id, result: {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'open-taskboard', version: '0.3.0' }
      }
    });
  }
  if (method?.startsWith('notifications/')) return;
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: toolsListResult(registry) });
  if (method === 'tools/call') {
    try {
      const name = params?.name;
      const tool = typeof name === 'string' ? registry.get(name) : undefined;
      if (tool === undefined) throw new Error(`unknown tool: ${name}`);
      const data = await tool.handler((params?.arguments ?? {}) as Record<string, unknown>);
      // A plain-string handler result IS the tool text (e.g. export_board);
      // every other shape is pretty-printed JSON as before.
      const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    } catch (err) {
      return send({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: `error: ${(err as Error).message}` }], isError: true }
      });
    }
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
}
