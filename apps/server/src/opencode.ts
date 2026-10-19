/**
 * OpenCode v1 HTTP adapter.
 *
 * The project wakeChannel points at the OpenCode server that owns the TUI.
 * Reuse that base URL for session discovery and dispatch so task binding and
 * wake-up cannot accidentally target different OpenCode instances.
 */
export interface OpenCodeSessionOption {
  id: string;
  title: string;
  directory: string;
  updatedAt: number | null;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeOpenCodeBase(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('OpenCode server URL is invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('OpenCode server URL must use http or https');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('OpenCode server URL must be an origin, e.g. http://127.0.0.1:4096');
  }
  return url.origin;
}

async function requestOpenCodeJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    // A configured server URL is user-controlled. Do not follow redirects to
    // a different host, and never let an unavailable local service hang the UI.
    redirect: 'error',
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) {
    throw new Error(`OpenCode server returned HTTP ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

/** List sessions owned by the configured OpenCode server (GET /session). */
export async function listOpenCodeSessions(serverUrl: string): Promise<OpenCodeSessionOption[]> {
  const base = normalizeOpenCodeBase(serverUrl);
  const payload = await requestOpenCodeJson(`${base}/session`);
  if (!Array.isArray(payload)) {
    throw new Error('OpenCode GET /session returned an unexpected response');
  }

  return payload.flatMap((item): OpenCodeSessionOption[] => {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id.length === 0) return [];
    const time = isRecord(item.time) ? item.time : {};
    return [{
      id: item.id,
      title: typeof item.title === 'string' && item.title.trim() ? item.title : item.id,
      directory: typeof item.directory === 'string' ? item.directory : '',
      updatedAt: typeof time.updated === 'number' ? time.updated : null
    }];
  });
}
