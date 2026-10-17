// 拖拽整组移动的纯逻辑（框架无关）。冲突重试语义：409 时按乐观锁纪律
// 「重读再改」取服务器最新 version 重试一次，仍失败才向上抛。
import { ApiError } from '../api';
import type { Issue, Status } from '../api';

/** 父任务拖动时需要跟随的子任务：同父、且当前状态与目标不同。 */
export function pickMovableChildren(issues: Issue[], parentId: string, status: Status): Issue[] {
  return issues.filter(i => i.parentId === parentId && i.status !== status);
}

export interface MoveApi {
  updateIssue(id: string, body: { status: Status; version: number }): Promise<unknown>;
  showIssue(id: string): Promise<{ version: number }>;
}

export async function moveWithRetry(api: MoveApi, issueId: string, status: Status, curVersion: number): Promise<void> {
  try {
    await api.updateIssue(issueId, { status, version: curVersion });
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 409) throw err;
    const fresh = await api.showIssue(issueId);
    await api.updateIssue(issueId, { status, version: fresh.version });
  }
}
