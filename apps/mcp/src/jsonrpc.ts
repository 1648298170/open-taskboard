// Transport layer: JSON-RPC 2.0 over stdio, newline-delimited. No tool logic
// lives here — tools arrive via the injected registry (DI); this module only
// frames requests, dispatches methods, and renders responses/error shapes.
import { toolsListResult, type ToolRegistry } from './tools/registry.js';

interface RpcMessage { jsonrpc: string; id?: number | string; method?: string; params?: Record<string, unknown> }

export function runStdioServer(registry: ToolRegistry): void {
  let buf = '';
  // Tool calls are async (HTTP fan-out); stdin 'end' must not kill in-flight
  // handlers — piped/batched clients lose their responses otherwise. Exit
  // only once the stream is closed AND every accepted request has drained.
  let pending = 0;
  let stdinEnded = false;
  const maybeExit = (): void => { if (stdinEnded && pending === 0) process.exit(0); };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) {
        pending++;
        void handleMessage(line, registry)
          .then(out => { if (out !== undefined) send(out); })
          .catch(e => process.stderr.write(`mcp: ${e}\n`))
          .finally(() => { pending--; maybeExit(); });
      }
    }
  });
  process.stdin.on('end', () => { stdinEnded = true; maybeExit(); });
}

const send = (msg: unknown): void => { process.stdout.write(JSON.stringify(msg) + '\n'); };

/** Frame one newline-delimited request and return the outgoing message
 * (undefined = nothing to send: parse failure or notification). Kept
 * transport-free so the dispatch table is testable without stdio. */
export async function handleMessage(line: string, registry: ToolRegistry): Promise<unknown | undefined> {
  let msg: RpcMessage;
  try { msg = JSON.parse(line); } catch { return undefined; }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0', id, result: {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'open-taskboard', version: '0.3.0' }
      }
    };
  }
  if (method?.startsWith('notifications/')) return undefined;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: toolsListResult(registry) };
  if (method === 'tools/call') {
    try {
      const name = params?.name;
      const tool = typeof name === 'string' ? registry.get(name) : undefined;
      if (tool === undefined) throw new Error(`unknown tool: ${name}`);
      const data = await tool.handler((params?.arguments ?? {}) as Record<string, unknown>);
      // A plain-string handler result IS the tool text (e.g. export_board);
      // every other shape is pretty-printed JSON as before.
      const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
    } catch (err) {
      return {
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: `error: ${(err as Error).message}` }], isError: true }
      };
    }
  }
  if (id !== undefined) return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
  return undefined;
}
