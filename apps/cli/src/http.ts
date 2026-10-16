// HTTP client for the taskboard API service.
export const URL_ENV = 'TASKBOARD_URL';

export const base = (): string => process.env[URL_ENV] || `http://127.0.0.1:${process.env.TASKBOARD_PORT || 47824}`;

export async function api(method: string, path: string, body?: unknown): Promise<any> {
  // T2-9: 服务端设置 TASKBOARD_TOKEN 时携带 Bearer 认证。
  const token = process.env.TASKBOARD_TOKEN;
  const res = await fetch(base() + path, {
    method,
    headers: {
      'x-taskboard-actor': 'cli',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`error: ${(data as { error?: string }).error ?? res.status}`); process.exit(1); }
  return data;
}
