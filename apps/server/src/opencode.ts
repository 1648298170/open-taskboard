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
  // Defense in depth against common cloud metadata SSRF targets. OpenCode
  // servers may legitimately run on loopback or a private LAN address, so
  // this deliberately blocks known metadata destinations rather than all
  // private IP ranges. Deployments accepting untrusted project settings should
  // additionally enforce an outbound host allowlist at the network boundary.
  const hostname = url.hostname.toLowerCase().replace(/^\\[|\\]$/g, '');
  const metadataHosts = new Set([
    'metadata', 'metadata.google.internal', 'metadata.azure.internal',
    'metadata.aws.internal', 'instance-data', 'metadata.tencentyun.com',
    'metadata.oraclecloud.com'
  ]);
  if (metadataHosts.has(hostname)
    || hostname === '100.100.100.200'
    || hostname === '169.254.169.254'
    || /^169\\.254\\./.test(hostname)
    || hostname === 'fd00:ec2::254'
    || /^fe[89ab][0-9a-f]:/i.test(hostname)) {
    throw new Error('OpenCode server URL targets a blocked link-local or cloud metadata address');
  }
  return url.origin;
}

async function requestOpenCodeJson(url: string, directory: string, method = 'GET', body?: unknown): Promise<unknown> {
  const requestUrl = new URL(url);
  if (directory) requestUrl.searchParams.set('directory', directory);
  const response = await fetch(requestUrl, {
    method,
    headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
export async function listOpenCodeSessions(serverUrl: string, directory = ''): Promise<OpenCodeSessionOption[]> {
  const base = normalizeOpenCodeBase(serverUrl);
  const payload = await requestOpenCodeJson(`${base}/session`, directory);
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

function normalizeDirectoryPath(value: string): string {
  const trimmed = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-zA-Z]:\//.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

/** Create a session in an explicit workspace directory (OpenCode v1 POST /session). */
export async function createOpenCodeSession(serverUrl: string, directory: string, title: string): Promise<OpenCodeSessionOption> {
  if (!directory.trim()) throw new Error('Workspace directory is required to create a session');
  const base = normalizeOpenCodeBase(serverUrl);

  // OpenCode's POST /session does not accept a directory in its JSON body.
  // The server resolves request context from ?directory=... (or the header).
  // Verify that the server honors that context before creating anything, so an
  // older/incompatible server cannot silently create a session in its startup cwd.
  const pathContext = await requestOpenCodeJson(`${base}/path`, directory);
  if (!isRecord(pathContext) || typeof pathContext.directory !== 'string') {
    throw new Error('OpenCode server did not report its active workspace directory; refusing to create a session');
  }
  if (normalizeDirectoryPath(pathContext.directory) !== normalizeDirectoryPath(directory)) {
    throw new Error(`OpenCode server is using "${pathContext.directory}" instead of the requested workspace "${directory}"; no session was created`);
  }

  const payload = await requestOpenCodeJson(`${base}/session`, directory, 'POST', { title: title.trim() });
  if (!isRecord(payload) || typeof payload.id !== 'string' || !payload.id) {
    throw new Error('OpenCode POST /session returned an unexpected response');
  }
  const returnedDirectory = typeof payload.directory === 'string' ? payload.directory : '';
  if (!returnedDirectory) throw new Error('OpenCode created a session but did not return its directory; refusing to bind it automatically');
  const time = isRecord(payload.time) ? payload.time : {};
  return {
    id: payload.id,
    title: typeof payload.title === 'string' && payload.title.trim() ? payload.title : title.trim(),
    directory: returnedDirectory,
    updatedAt: typeof time.updated === 'number' ? time.updated : null
  };
}
