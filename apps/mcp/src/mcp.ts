#!/usr/bin/env node
// MCP server for open-taskboard (stdio, JSON-RPC 2.0). Thin entry:
//   - jsonrpc.ts     transport (framing, dispatch, protocol responses)
//   - connection.ts  HTTP forwarding + auto-start policy
//   - tools/         registry: zod-generated schemas bound to handlers
import { runStdioServer } from './jsonrpc.js';
import { createRegistry } from './tools/registry.js';
import { projectTools } from './tools/projects.js';
import { issueTools } from './tools/issues.js';

runStdioServer(createRegistry(projectTools, issueTools));
