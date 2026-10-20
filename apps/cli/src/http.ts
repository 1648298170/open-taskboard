// HTTP client for the taskboard API service.
import { resolveClientConfig } from '@taskboard/core';

export const URL_ENV = 'TASKBOARD_URL';

export const base = (): string => resolveClientConfig(process.env).baseUrl;

export const clientToken = (): string => resolveClientConfig(process.env).token;

export const SESSION_ENV = 'TASKBOARD_SESSION_ID';

/** Resolve the outbound agent session: explicit opt (trimmed) wins over env. */
export const resolveSession = (explicit?: string): string | undefined => {
  const pick = (value: string | undefined): string | undefined => {
    const trimmed = (value ?? '').trim();
    return trimmed || undefined;
  };
  return pick(explicit) ?? pick(process.env[SESSION_ENV]);
};

export interface ApiOptions { sessionId?: string }

export async function api(method: string, path: string, body?: unknown, opts?: ApiOptions): Promise<any> {
  // T2-9: 服务端设置 TASKBOARD_TOKEN 时携带 Bearer 认证。
  const token = clientToken();
  const session = resolveSession(opts?.sessionId);
  const res = await fetch(base() + path, {
    method,
    headers: {
      'x-taskboard-actor': 'cli',
      ...(session ? { 'x-taskboard-session': session } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`error: ${(data as { error?: string }).error ?? res.status}`); process.exit(1); }
  return data;
}
