// Typed API client + SSE subscription. Types come from @taskboard/core —
// one definition shared by server / cli / mcp / web. Imported via the
// './types' subpath so the Node-only SQLite Store stays out of the bundle.
import type {
  Comment, Issue, IssueDetail, Priority, Progress, Project, Status
} from '@taskboard/core/types';

export type { Comment, Issue, IssueDetail, Priority, Progress, Project, Status };
export { STATUSES } from '@taskboard/core/types';
export const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'urgent'];

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api_ = {
  listProjects: () => api<Project[]>('GET', '/api/projects'),
  createProject: (p: { id?: string; name: string; workspacePath?: string }) => api<Project>('POST', '/api/projects', p),
  listIssues: (projectId: string) => api<Issue[]>('GET', `/api/projects/${projectId}/issues`),
  showIssue: (id: string) => api<IssueDetail>('GET', `/api/issues/${id}`),
  createIssue: (projectId: string, body: Partial<Issue> & { title: string }) =>
    api<Issue>('POST', `/api/projects/${projectId}/issues`, body),
  updateIssue: (id: string, body: { version: number } & Partial<Issue>) =>
    api<Issue>('PATCH', `/api/issues/${id}`, body),
  deleteIssue: (id: string) => api<{ ok: true }>('DELETE', `/api/issues/${id}`),
  addComment: (id: string, author: string, body: string) =>
    api<Comment>('POST', `/api/issues/${id}/comments`, { author, body }),
  progress: (projectId: string) => api<Progress>('GET', `/api/projects/${projectId}/progress`)
};

export function connectSSE(onChange: () => void): () => void {
  let revision: number | null = null;
  let closed = false;
  let es: EventSource | null = null;

  const connect = (): void => {
    if (closed) return;
    es = new EventSource('/api/events');
    es.addEventListener('hello', e => { revision = JSON.parse((e as MessageEvent).data).revision; });
    es.addEventListener('change', e => {
      const ev = JSON.parse((e as MessageEvent).data);
      if (ev.revision !== revision) { revision = ev.revision; onChange(); }
    });
    es.onerror = () => { es?.close(); setTimeout(connect, 2000); };
  };
  connect();
  return () => { closed = true; es?.close(); };
}
