/**
 * OpenCode v1 HTTP adapter.
 *
 * The project wakeChannel points at the OpenCode server that owns the TUI.
 * Reuse that base URL for session discovery and dispatch so task binding and
 * wake-up cannot accidentally target different OpenCode instances.
 */
import { lookup } from 'node:dns/promises';
import { posix, resolve, win32 } from 'node:path';
import { isIP } from 'node:net';

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

/** Last-resort OpenCode origin when nothing explicit is configured. */
export const FALLBACK_OPENCODE_URL = 'http://127.0.0.1:4096';

/**
 * Resolve the OpenCode origin for flows that have no explicit URL (web
 * create-project / stateless session discovery). Precedence:
 * explicit url → TASKBOARD_OPENCODE_URL → newest project wakeChannel →
 * FALLBACK_OPENCODE_URL. Blank candidates are skipped; an invalid candidate
 * throws (callers map that to 400).
 */
export function resolveOpenCodeBase(explicitUrl: string | undefined, projectChannels: string[]): string {
  const explicit = (explicitUrl ?? '').trim();
  if (explicit) return normalizeOpenCodeBase(explicit);

  const fromEnv = (process.env.TASKBOARD_OPENCODE_URL ?? '').trim();
  if (fromEnv) return normalizeOpenCodeBase(fromEnv);

  const channel = projectChannels.map(c => c.trim()).find(c => c.length > 0);
  if (channel) return normalizeOpenCodeBase(channel);

  return normalizeOpenCodeBase(FALLBACK_OPENCODE_URL);
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
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const metadataHosts = new Set([
    'metadata', 'metadata.google.internal', 'metadata.azure.internal',
    'metadata.aws.internal', 'instance-data', 'metadata.tencentyun.com',
    'metadata.oraclecloud.com'
  ]);
  if (metadataHosts.has(hostname)
    || hostname === '100.100.100.200'
    || hostname === '169.254.169.254'
    || /^169\.254\./.test(hostname)
    || hostname === 'fd00:ec2::254'
    || /^fe[89ab][0-9a-f]:/i.test(hostname)) {
    throw new Error('OpenCode server URL targets a blocked link-local or cloud metadata address');
  }
  return url.origin;
}

function isBlockedMetadataAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0] ?? address.toLowerCase();
  return normalized === '100.100.100.200'
    || normalized === '169.254.169.254'
    || /^169\.254\./.test(normalized)
    || normalized === 'fd00:ec2::254'
    || /^fe[89ab][0-9a-f]:/i.test(normalized)
    || /^::ffff:169\.254\./i.test(normalized);
}

async function assertSafeOpenCodeDestination(url: URL): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) {
    if (isBlockedMetadataAddress(hostname)) {
      throw new Error('OpenCode server URL resolves to a blocked cloud metadata or link-local address');
    }
    return;
  }
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('OpenCode server hostname could not be resolved');
  }
  if (addresses.length === 0 || addresses.some(item => isBlockedMetadataAddress(item.address))) {
    throw new Error('OpenCode server hostname resolves to a blocked cloud metadata or link-local address');
  }
}

async function requestOpenCodeJson(url: string, directory: string, method = 'GET', body?: unknown): Promise<unknown> {
  const requestUrl = new URL(url);
  await assertSafeOpenCodeDestination(requestUrl);
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

/**
 * Keep only sessions whose directory is the given workspace. Empty/blank
 * workspace → all sessions (the UI then shows everything the server knows).
 * Paths are resolved, slash-normalized and (on win32) case-folded so the web
 * UI's `C:\x` and OpenCode's `C:/x` are treated as the same workspace.
 */
export function filterSessionsByWorkspace(
  sessions: OpenCodeSessionOption[],
  workspacePath: string
): OpenCodeSessionOption[] {
  const workspace = workspacePath.trim();
  if (!workspace) return sessions;
  const normalizePath = (value: string): string => {
    const absolute = resolve(value).replace(/\\/g, '/').replace(/\/$/, '');
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  const target = normalizePath(workspace);
  return sessions.filter(session => session.directory && normalizePath(session.directory) === target);
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

export interface OpenCodeDirectoryEntry {
  name: string;
  path: string;
}

export interface OpenCodeDirectoryListing {
  path: string;
  parentPath: string | null;
  entries: OpenCodeDirectoryEntry[];
}

function parentDirectoryPath(value: string): string | null {
  // The Taskboard server may run on Linux while OpenCode serves a Windows path.
  // Choose the path parser from the returned path, not from the server OS.
  const windowsPath = /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value);
  const parent = windowsPath ? win32.dirname(value) : posix.dirname(value);
  return parent === value || parent === '.' ? null : parent;
}

/** Browse one directory on the OpenCode server's filesystem (GET /file). */
export async function listOpenCodeDirectories(
  serverUrl: string,
  requestedPath = ''
): Promise<OpenCodeDirectoryListing> {
  const base = normalizeOpenCodeBase(serverUrl);
  let directoryPath = requestedPath.trim();

  // With no starting path, use the configured OpenCode server's current workspace.
  if (!directoryPath) {
    const current = await requestOpenCodeJson(`${base}/path`, '');
    if (!isRecord(current) || typeof current.directory !== 'string' || !current.directory.trim()) {
      throw new Error('OpenCode server did not return its current directory');
    }
    directoryPath = current.directory.trim();
  }

  const query = new URLSearchParams({ path: directoryPath });
  const payload = await requestOpenCodeJson(`${base}/file?${query.toString()}`, '');
  if (!Array.isArray(payload)) {
    throw new Error('OpenCode GET /file returned an unexpected response');
  }

  const entries = payload.flatMap((item): OpenCodeDirectoryEntry[] => {
    if (!isRecord(item) || item.type !== 'directory' || typeof item.name !== 'string') return [];
    // FileNode.absolute is the absolute path. Do not fall back to its possibly
    // workspace-relative "path" field, otherwise selection could save a bad path.
    if (typeof item.absolute !== 'string' || !item.absolute.trim()) return [];
    return [{ name: item.name, path: item.absolute }];
  }).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  return {
    path: directoryPath,
    parentPath: parentDirectoryPath(directoryPath),
    entries
  };
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
