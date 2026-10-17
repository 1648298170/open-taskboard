// Connection policy: talk to the local taskboard HTTP service, auto-starting it
// via @taskboard/server when nothing is listening. Behavior preserved verbatim
// from the pre-refactor mcp.ts: env-respect (host/port only defaulted when
// unset), TASKBOARD_DATA_DIR absolute-resolve, cwd pinning, unref'd spawn,
// 300ms poll interval, 10s deadline, diagnosable final error.
import { spawn, ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { resolveClientConfig } from '@taskboard/core';

const require = createRequire(import.meta.url);
const SERVER_JS = require.resolve('@taskboard/server'); // -> apps/server/dist/index.js (package main)

export const base = (): string => resolveClientConfig(process.env).baseUrl;

export async function apiOnce(method: string, path: string, body?: unknown): Promise<unknown> {
  // T2-9: 服务端设置 TASKBOARD_TOKEN 时携带 Bearer 认证。
  const token = resolveClientConfig(process.env).token;
  const res = await fetch(base() + path, {
    method,
    headers: {
      'x-taskboard-actor': 'mcp',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data;
}

let serverStarter: ChildProcess | null = null;
const AUTO_START_TIMEOUT_MS = 10000;
const AUTO_START_POLL_MS = 300;

// Only retry when the connection was never established (safe to replay POSTs).
export const isNetworkFailure = (err: unknown): boolean => {
  const cause = (err as NodeJS.ErrnoException).cause as NodeJS.ErrnoException | undefined;
  return cause?.code === 'ECONNREFUSED';
};

// Single request attempt, escalated to auto-start + polling on network failure.
// Resolves with the API response once the service is reachable, or throws the
// diagnosable error (base() included) when the 10s deadline passes.
export async function ensureServerOrThrow(method: string, path: string, body?: unknown): Promise<unknown> {
  try {
    return await apiOnce(method, path, body);
  } catch (err) {
    if (!isNetworkFailure(err)) throw err;
    if (!serverStarter) {
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (env.TASKBOARD_HOST === undefined) env.TASKBOARD_HOST = '127.0.0.1';
      if (env.TASKBOARD_PORT === undefined) env.TASKBOARD_PORT = '47824';
      if (env.TASKBOARD_DATA_DIR !== undefined) env.TASKBOARD_DATA_DIR = resolve(env.TASKBOARD_DATA_DIR);
      serverStarter = spawn(process.execPath, [SERVER_JS], {
        stdio: 'ignore', detached: false, cwd: process.cwd(), env
      });
      serverStarter.unref();
      serverStarter.once('exit', () => { serverStarter = null; });
    }
    const deadline = Date.now() + AUTO_START_TIMEOUT_MS;
    for (;;) {
      await new Promise(r => setTimeout(r, AUTO_START_POLL_MS));
      try {
        return await apiOnce(method, path, body);
      } catch (retryErr) {
        if (!isNetworkFailure(retryErr)) throw retryErr;
        if (Date.now() >= deadline) {
          throw new Error(
            `无法连接 taskboard 服务 (${base()})：已尝试自动拉起服务，但 ${AUTO_START_TIMEOUT_MS}ms 内未就绪` +
            `（最后错误：${(retryErr as Error).message}）。请手动运行 \`taskboard serve\`，或用 TASKBOARD_URL 指向已运行的服务`
          );
        }
      }
    }
  }
}
