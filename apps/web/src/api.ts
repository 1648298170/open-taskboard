// Typed API client + SSE subscription. Types come from @taskboard/core —
// one definition shared by server / cli / mcp / web. Imported via the
// './types' subpath so the Node-only SQLite Store stays out of the bundle.
import type {
  Activity, AppSettings, Attachment, Comment, DependencyEdge, Issue, IssueDetail as CoreIssueDetail, Priority, Progress, Project, Stats, Status, WorkspaceDirectory
} from '@taskboard/core/types';

/** IssueDetail plus the server-computed browser link to the inherited OpenCode Session. */
export interface IssueDetail extends CoreIssueDetail {
  /** Null when TASKBOARD_OPENCODE_PUBLIC_URL is unconfigured or no Session is bound. */
  sessionUrl?: string | null;
}

export type {
  Activity, Attachment, Comment, DependencyEdge, Issue, Priority, Progress, Project, Stats, Status, WorkspaceDirectory
};
export { STATUSES, PRIORITIES, activeClaim } from '@taskboard/core/types';
/** 中文状态名映射（列头/下拉/统计 chip 显示用；数据层存英文枚举不变） */
export const STATUS_CN: Record<string, string> = { todo: '待办', in_progress: '进行中', in_review: '待验收', done: '完成' };

/** T2-8: git-refs scan result for a project workspace. */
export interface GitRefs {
  branches: string[];
  worktrees: { name: string; path: string }[];
}

/** T6-36: one-line git commit summary（最近提交预览）。 */
export interface Commit {
  hash: string;
  subject: string;
  when: string;
}

/** OpenCode session returned by the project's configured OpenCode server. */
export interface OpenCodeSessionOption {
  id: string;
  title: string;
  directory: string;
  updatedAt: number | null;
}

/** OpenCode's authoritative runtime snapshot used to reattach after reconnect/restart. */
export interface OpenCodeSessionRuntimeState {
  sessionId: string;
  title: string;
  directory: string;
  updatedAt: number | null;
  status: { type: string; [key: string]: unknown } | null;
  busy: boolean;
  observedAt: string;
  issueStatus: Status;
  recoverable: boolean;
}

export interface WorkspaceDirectoryEntry {
  name: string;
  path: string;
}

export interface DirectoryOpenCodeProjectStatus {
  projectId: string;
  projectName: string;
  sessionId: string | null;
  status: string;
  busy: boolean | null;
  statusType?: string | null;
  observedAt?: string;
  error?: string;
}

export interface GlobalOpenCodeStatus {
  checkedAt: string;
  serverStatus: 'connected' | 'unavailable';
  error?: string;
  projects: (DirectoryOpenCodeProjectStatus & { directoryName: string; workspacePath: string; sessionUrl?: string | null })[];
}



export interface WorkspaceDirectoryListing {
  path: string;
  parentPath: string | null;
  entries: WorkspaceDirectoryEntry[];
  drives: WorkspaceDirectoryEntry[];
}

/** API errors carry HTTP status so the app can route 401 responses to login. */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export interface AuthStatus {
  authRequired: boolean;
  initialized: boolean;
  authenticated: boolean;
  username: string | null;
}

async function requestJson<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? ('HTTP ' + res.status), res.status);
  return data as T;
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      'x-taskboard-actor': 'web',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? ('HTTP ' + res.status), res.status);
  return data as T;
}

export const api_ = {
  authStatus: () => requestJson<AuthStatus>('/api/auth/status', 'GET'),
  initializeAdmin: (username: string, password: string) =>
    requestJson<{ ok: true; username: string }>('/api/auth/setup', 'POST', { username, password }),
  login: (username: string, password: string) =>
    requestJson<{ ok: true; username: string }>('/api/auth/login', 'POST', { username, password }),
  logout: () => requestJson<{ ok: true }>('/api/auth/logout', 'POST'),

  getSettings: () => api<AppSettings>('GET', '/api/settings'),
  updateSettings: (p: Partial<AppSettings>) => api<AppSettings>('PUT', '/api/settings', p),
  browseWorkspaceDirectories: (path?: string) => {
    const query = new URLSearchParams();
    if (path?.trim()) query.set('path', path.trim());
    const qs = query.toString();
    return api<WorkspaceDirectoryListing>('GET', `/api/directories/browse${qs ? `?${qs}` : ''}`);
  },
  openCodeStatus: () => api<GlobalOpenCodeStatus>('GET', '/api/opencode/status'),
  listDirectories: () => api<WorkspaceDirectory[]>('GET', '/api/directories'),
  createDirectory: (p: { id?: string; name: string; workspacePath?: string }) =>
    api<WorkspaceDirectory>('POST', '/api/directories', p),
  updateDirectory: (id: string, p: { name?: string; workspacePath?: string }) =>
    api<WorkspaceDirectory>('PATCH', `/api/directories/${encodeURIComponent(id)}`, p),
  deleteDirectory: (id: string, options?: { cascade?: boolean }) =>
    api<{ ok: true }>('DELETE', `/api/directories/${encodeURIComponent(id)}${options?.cascade ? '?cascade=1' : ''}`),
  openCodeSessionsForDirectory: (id: string) =>
    api<{ sessions: OpenCodeSessionOption[]; directoryId: string; directoryPath: string }>(
      'GET', `/api/directories/${encodeURIComponent(id)}/opencode-sessions`
    ),
  createOpenCodeSession: (id: string, title: string) =>
    api<{ session: OpenCodeSessionOption; directoryId: string }>(
      'POST', `/api/directories/${encodeURIComponent(id)}/opencode-sessions`, { title }
    ),
  listProjects: () => api<Project[]>('GET', '/api/projects'),
  createProject: (p: { id?: string; name: string; directoryId?: string; defaultSessionId?: string | null; labels?: string }) => api<Project>('POST', '/api/projects', p),
  updateProject: (id: string, p: { name?: string; labels?: string; defaultSessionId?: string | null }) => api<Project>('PATCH', `/api/projects/${id}`, p),
  deleteProject: (id: string) => api<void>('DELETE', `/api/projects/${id}`),
  listIssues: (projectId: string) => api<Issue[]>('GET', `/api/projects/${projectId}/issues`),
  showIssue: (id: string) => api<IssueDetail>('GET', `/api/issues/${id}`),
  createIssue: (projectId: string, body: Partial<Issue> & { title: string }) =>
    api<Issue>('POST', `/api/projects/${projectId}/issues`, body),
  updateIssue: (id: string, body: { version: number; statusNote?: string } & Partial<Issue>) =>
    api<Issue>('PATCH', `/api/issues/${id}`, body),
  deleteIssue: (id: string) => api<{ ok: true }>('DELETE', `/api/issues/${id}`),
  archiveIssue: (id: string) => api<{ ok: true }>('POST', `/api/issues/${id}/archive`, {}),
  unarchiveIssue: (id: string) => api<{ ok: true }>('POST', `/api/issues/${id}/unarchive`, {}),
  // T7-34: 独占租约。Web 端固定以 agent 'web' 认领/释放。
  claimIssue: (id: string, agent = 'web', ttlMinutes?: number) =>
    api<Issue>('POST', `/api/issues/${id}/claim`,
      { agent, ...(ttlMinutes !== undefined ? { ttlMinutes } : {}) }),
  heartbeatIssue: (id: string, agent = 'web') =>
    api<Issue>('POST', `/api/issues/${id}/heartbeat`, { agent }),
  releaseIssue: (id: string, agent = 'web') =>
    api<Issue>('POST', `/api/issues/${id}/release`, { agent }),
  addComment: (id: string, body: string) =>
    api<Comment>('POST', `/api/issues/${id}/comments`, { body }),
  deleteComment: (commentId: string) =>
    api<{ ok: true }>('DELETE', `/api/comments/${commentId}`),
  updateComment: (commentId: string, patch: { body?: string; status?: string }) =>
    api<Comment>('PATCH', `/api/comments/${commentId}`, patch),
  // Multipart uploads and normal downloads use the same-origin HttpOnly session cookie.
  uploadAttachment: async (id: string, file: File): Promise<Attachment> => {
    const form = new FormData();
    form.append('file', file, file.name);
    const res = await fetch('/api/issues/' + id + '/attachments', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-taskboard-actor': 'web' },
      body: form
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError((data as { error?: string }).error ?? ('HTTP ' + res.status), res.status);
    return data as Attachment;
  },
  downloadUrl: (attachmentId: string): string => '/api/attachments/' + attachmentId + '/download',
  deleteAttachment: (attachmentId: string) => api<{ ok: true }>('DELETE', `/api/attachments/${encodeURIComponent(attachmentId)}`),
  listDependencies: (projectId: string) =>
    api<DependencyEdge[]>('GET', `/api/projects/${projectId}/dependencies`),
  addDependency: (id: string, dependsOnId: string) =>
    api<{ ok: true }>('POST', `/api/issues/${id}/dependencies`, { dependsOnId }),
  removeDependency: (id: string, dependsOnId: string) =>
    api<{ ok: true }>('DELETE', `/api/issues/${id}/dependencies/${dependsOnId}`),
  progress: (projectId: string) => api<Progress>('GET', `/api/projects/${projectId}/progress`),
  stats: (projectId: string) => api<Stats>('GET', `/api/projects/${projectId}/stats?weeks=8`),
  openCodeSessions: (projectId: string) => api<{ sessions: OpenCodeSessionOption[]; workspacePath: string }>('GET', `/api/projects/${encodeURIComponent(projectId)}/opencode-sessions`),
  // 新建项目对话框用：无项目 id 的无状态查询，按服务地址 + 可选工作区过滤会话。
  // Session discovery always uses the server-side deployment configuration.
  openCodeSessionsFor: (workspacePath?: string) => {
    const query = new URLSearchParams();
    if (workspacePath) query.set('workspacePath', workspacePath);
    const qs = query.toString();
    return api<{ sessions: OpenCodeSessionOption[]; workspacePath: string }>('GET', `/api/opencode/sessions${qs ? `?${qs}` : ''}`);
  },
  createTaskWorktree: (id: string) => api<{ issue: Issue; branch: string; worktree: string; worktreePath: string; alreadyBound: boolean }>('POST', `/api/issues/${encodeURIComponent(id)}/create-worktree`, {}),
  releaseGitBinding: (id: string) => api<Issue>('DELETE', `/api/issues/${encodeURIComponent(id)}/git-binding`),
  /** Query OpenCode itself after a Taskboard reload to recover live Session state. */
  openCodeSessionState: (id: string) => api<OpenCodeSessionRuntimeState>('GET', `/api/issues/${encodeURIComponent(id)}/opencode-state`),
  /** Abort the actual OpenCode Session, not just the Taskboard issue status. */
  abortOpenCodeSession: (id: string) => api<{ ok: true; sessionId: string; requestedAt: string }>('POST', `/api/issues/${encodeURIComponent(id)}/opencode-abort`, {}),

  gitRefs: (projectId: string) => api<GitRefs>('GET', `/api/projects/${projectId}/git-refs`),
  commits: (projectId: string, ref: string) =>
    api<{ commits: Commit[] }>('GET', `/api/projects/${projectId}/commits?ref=${encodeURIComponent(ref)}`)
      .then(r => r.commits)
};

/**
 * Subscribe to the OpenCode Session bound to one issue. EventSource handles
 * reconnects; the ready event is emitted on every connection so callers can
 * fetch an authoritative state snapshot and recover anything missed offline.
 */
export function connectOpenCodeSessionEvents(
  issueId: string,
  onEvent: (event: unknown) => void,
  onReady: () => void,
  onError: (message: string) => void
): () => void {
  const es = new EventSource('/api/issues/' + encodeURIComponent(issueId) + '/opencode-events');
  es.addEventListener('ready', () => onReady());
  es.addEventListener('opencode', event => {
    try { onEvent(JSON.parse((event as MessageEvent<string>).data) as unknown); }
    catch { onError('收到无法解析的 OpenCode 事件'); }
  });
  es.addEventListener('upstream-error', event => {
    try {
      const payload = JSON.parse((event as MessageEvent<string>).data) as { error?: string };
      onError(payload.error ?? 'OpenCode 事件流异常');
    } catch { onError('OpenCode 事件流异常'); }
  });
  es.onerror = () => onError('OpenCode 事件连接断开，正在自动重连');
  return () => es.close();
}

/** 上层路由所需的 StoreEvent 摘要；不解一整个事件体，避免把后端形状耦合进 UI。 */
export interface SseChangeEvent {
  /** StoreEvent.type，如 issue.updated / project.created；解析失败时为空串。 */
  type: string;
  /** issue/comment/dependency 事件携带的任务 id；hello 与未知事件为 null。 */
  issueId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 解析一帧 `change` 的 StoreEvent JSON。永远不抛错——坏帧降级为空 type
 * （上层按未知事件处理），不能因为一条脏数据断掉整个刷新链路。
 */
export function parseSseChange(data: string): SseChangeEvent {
  let parsed: unknown;
  try { parsed = JSON.parse(data); } catch { return { type: '', issueId: null }; }
  if (!isRecord(parsed)) return { type: '', issueId: null };
  const type = typeof parsed.type === 'string' ? parsed.type : '';
  const payload = isRecord(parsed.payload) ? parsed.payload : {};
  // comment.* / dependency.* 自带 issueId；issue.* 只带任务自身的 id。
  const issueId = typeof payload.issueId === 'string'
    ? payload.issueId
    : type.startsWith('issue.') && typeof payload.id === 'string' ? payload.id : null;
  return { type, issueId };
}

export function connectSSE(onChange: (event: SseChangeEvent) => void): () => void {
  let closed = false;
  let es: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = 2000;
  // 首次连接不触发 hello 全量刷新：调用方挂载时已自行加载首屏数据，
  // 再刷一次等于把 projects/directories/issues/progress/deps 全部翻倍。
  // 只有「重连」的 hello 才需要兜底（断线期间错过的 change 事件）。
  let connectedBefore = false;

  const connect = (): void => {
    if (closed) return;
    // Same-origin EventSource automatically includes the HttpOnly session cookie.
    es = new EventSource('/api/events');
    es.addEventListener('hello', () => {
      delay = 2000;
      if (!connectedBefore) {
        connectedBefore = true;
        return;
      }
      onChange({ type: 'hello', issueId: null });
    });
    // 每个 change 事件对应一次 store 变更；带上类型交给上层按需路由 + 合并。
    // 不能按 revision 去重：heartbeat 不 bump version，revision 不变，按
    // revision 过滤会把租约徽章的刷新吞掉。
    es.addEventListener('change', event => {
      onChange(parseSseChange((event as MessageEvent<string>).data));
    });
    es.onerror = () => {
      es?.close();
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, 30_000); // 指数退避，hello 成功后复位
    };
  };
  connect();
  return () => {
    closed = true;
    es?.close();
    if (timer !== null) clearTimeout(timer);
  };
}
