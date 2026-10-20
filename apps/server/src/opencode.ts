/**
 * OpenCode v1 HTTP adapter.
 *
 * The project wakeChannel points at the OpenCode server that owns the TUI.
 * Reuse that base URL for session discovery and dispatch so task binding and
 * wake-up cannot accidentally target different OpenCode instances.
 */
import { resolve } from 'node:path';

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
