// HTTP client for the taskboard API service.
export const URL_ENV = 'TASKBOARD_URL';

export const base = (): string => process.env[URL_ENV] || `http://127.0.0.1:${process.env.TASKBOARD_PORT || 47824}`;

export async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(base() + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`error: ${(data as { error?: string }).error ?? res.status}`); process.exit(1); }
  return data;
}
