// Typed API client + SSE subscription. Types come from @taskboard/core —
// one definition shared by server / cli / mcp / web. Imported via the
// './types' subpath so the Node-only SQLite Store stays out of the bundle.
import type {
  Activity, Attachment, Comment, DependencyEdge, Issue, IssueDetail, Priority, Progress, Project, Stats, Status, WorkspaceDirectory
} from '@taskboard/core/types';

export type {
  Activity, Attachment, Comment, DependencyEdge, Issue, IssueDetail, Priority, Progress, Project, Stats, Status, WorkspaceDirectory
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

/** T2-9: API 错误，携带 HTTP status — App 据此识别 401 并弹出令牌输入。 */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** localStorage 中保存的访问令牌（T2-9）；空串 = 未设置。 */
const bearerToken = (): string => localStorage.getItem('taskboard-token') ?? '';

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = bearerToken();
  const res = await fetch(path, {
    method,
    headers: {
      'x-taskboard-actor': 'web',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `HTTP ${res.status}`, res.status);
  return data as T;
}

export const api_ = {
  getSettings: () => api<{ defaultWorkspacePath: string }>('GET', '/api/settings'),
  updateSettings: (p: { defaultWorkspacePath: string }) => api<{ defaultWorkspacePath: string }>('PUT', '/api/settings', p),
  listDirectories: () => api<WorkspaceDirectory[]>('GET', '/api/directories'),
  createDirectory: (p: { id?: string; name: string; workspacePath?: string }) =>
    api<WorkspaceDirectory>('POST', '/api/directories', p),
  updateDirectory: (id: string, p: { name?: string; workspacePath?: string }) =>
    api<WorkspaceDirectory>('PATCH', `/api/directories/${encodeURIComponent(id)}`, p),
  deleteDirectory: (id: string) => api<{ ok: true }>('DELETE', `/api/directories/${encodeURIComponent(id)}`),
  openCodeSessionsForDirectory: (id: string, workspacePath: string, serverUrl: string) =>
    api<{ sessions: OpenCodeSessionOption[]; directoryId: string; directoryPath: string; serverUrl: string }>(
      'GET', `/api/directories/${encodeURIComponent(id)}/opencode-sessions?workspacePath=${encodeURIComponent(workspacePath)}&serverUrl=${encodeURIComponent(serverUrl)}`
    ),
  createOpenCodeSession: (id: string, title: string, workspacePath: string, serverUrl: string) =>
    api<{ session: OpenCodeSessionOption; directoryId: string; serverUrl: string }>(
      'POST', `/api/directories/${encodeURIComponent(id)}/opencode-sessions`, { title, workspacePath, serverUrl }
    ),
  listProjects: () => api<Project[]>('GET', '/api/projects'),
  createProject: (p: { id?: string; name: string; directoryId?: string; defaultSessionId?: string | null; workspacePath?: string; wakeChannel?: string; labels?: string }) => api<Project>('POST', '/api/projects', p),
  updateProject: (id: string, p: { name?: string; workspacePath?: string; wakeChannel?: string; defaultSessionId?: string | null }) => api<Project>('PATCH', `/api/projects/${id}`, p),
  deleteProject: (id: string) => api<void>('DELETE', `/api/projects/${id}`),
  listIssues: (projectId: string) => api<Issue[]>('GET', `/api/projects/${projectId}/issues`),
  showIssue: (id: string) => api<IssueDetail>('GET', `/api/issues/${id}`),
  createIssue: (projectId: string, body: Partial<Issue> & { title: string }) =>
    api<Issue>('POST', `/api/projects/${projectId}/issues`, body),
  updateIssue: (id: string, body: { version: number } & Partial<Issue>) =>
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
  addComment: (id: string, author: string, body: string) =>
    api<Comment>('POST', `/api/issues/${id}/comments`, { author, body }),
  deleteComment: (commentId: string) =>
    api<{ ok: true }>('DELETE', `/api/comments/${commentId}`),
  updateComment: (commentId: string, patch: { body?: string; status?: string }) =>
    api<Comment>('PATCH', `/api/comments/${commentId}`, patch),
  // T7-39: 附件上传是 multipart，不能走 JSON 的 api() —— 独立实现（同样带
  // Bearer + actor 头）；下载用 <a href> 直链，令牌经 ?token= 传递（与 SSE 同法）。
  uploadAttachment: async (id: string, file: File): Promise<Attachment> => {
    const token = bearerToken();
    const form = new FormData();
    form.append('file', file, file.name);
    const res = await fetch(`/api/issues/${id}/attachments`, {
      method: 'POST',
      headers: {
        'x-taskboard-actor': 'web',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: form
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `HTTP ${res.status}`, res.status);
    return data as Attachment;
  },
  downloadUrl: (attachmentId: string): string => {
    const token = bearerToken();
    return `/api/attachments/${attachmentId}/download${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  },
  listDependencies: (projectId: string) =>
    api<DependencyEdge[]>('GET', `/api/projects/${projectId}/dependencies`),
  addDependency: (id: string, dependsOnId: string) =>
    api<{ ok: true }>('POST', `/api/issues/${id}/dependencies`, { dependsOnId }),
  removeDependency: (id: string, dependsOnId: string) =>
    api<{ ok: true }>('DELETE', `/api/issues/${id}/dependencies/${dependsOnId}`),
  progress: (projectId: string) => api<Progress>('GET', `/api/projects/${projectId}/progress`),
  stats: (projectId: string) => api<Stats>('GET', `/api/projects/${projectId}/stats?weeks=8`),
  openCodeSessions: (projectId: string) => api<{ sessions: OpenCodeSessionOption[]; workspacePath: string; serverUrl: string }>('GET', `/api/projects/${encodeURIComponent(projectId)}/opencode-sessions`),
  gitRefs: (projectId: string) => api<GitRefs>('GET', `/api/projects/${projectId}/git-refs`),
  commits: (projectId: string, ref: string) =>
    api<{ commits: Commit[] }>('GET', `/api/projects/${projectId}/commits?ref=${encodeURIComponent(ref)}`)
      .then(r => r.commits)
};

export function connectSSE(onChange: () => void): () => void {
  let closed = false;
  let es: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = 2000;

  const connect = (): void => {
    if (closed) return;
    // EventSource 无法带自定义 header —— 令牌通过 ?token= 传递（每次重连
    // 重新读取，保存新令牌后的自动重连即可恢复）。
    const token = bearerToken();
    es = new EventSource(`/api/events${token ? `?token=${encodeURIComponent(token)}` : ''}`);
    es.addEventListener('hello', () => {
      delay = 2000;
      // hello（首次连接与每次重连）都全量刷新：断线期间的变更只会体现在
      // 新数据里且 change 事件已错过，靠这次兜底拉取。首次连接无害——数据
      // 本就要加载。
      onChange();
    });
    // 每个 change 事件对应一次 store 变更，直接刷新——不能按 revision 去重：
    // heartbeat 不 bump version，revision 不变，按 revision 过滤会把租约
    // 徽章的刷新吞掉。
    es.addEventListener('change', () => onChange());
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
