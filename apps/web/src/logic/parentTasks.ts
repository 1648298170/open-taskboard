// 新建任务对话框「父任务」候选的纯逻辑（框架无关，node:test 可测）。
// 只有顶层且未完成的任务可被选作父任务；排序稳定：状态优先，同状态按标题。
import { STATUS_CN } from '../api';
import type { Issue } from '../api';

/** 可作父任务的候选：顶层（无 parentId）且未完成。 */
export function isParentCandidate(issue: Issue): boolean {
  return !issue.parentId && issue.status !== 'done';
}

/** 父任务候选列表：过滤后按 todo → in_progress → in_review 排序，
 *  同状态内按标题（中文排序）。返回新数组，不改动入参。 */
export function parentCandidates(issues: Issue[]): Issue[] {
  const order: string[] = ['todo', 'in_progress', 'in_review'];
  return issues.filter(isParentCandidate).sort((a, b) => {
    const diff = order.indexOf(a.status) - order.indexOf(b.status);
    return diff !== 0 ? diff : a.title.localeCompare(b.title, 'zh');
  });
}

/** 候选显示文案：标题 + 全角括号状态名（未映射状态回退原始值）。 */
export function parentLabel(issue: Issue): string {
  return `${issue.title}（${STATUS_CN[issue.status] ?? issue.status}）`;
}

/** 按查询串过滤候选：空白查询返回全部；否则标题或 id 的大小写不敏感
 *  子串匹配，并保持 parentCandidates 的排序。 */
export function filterParentCandidates(issues: Issue[], query: string): Issue[] {
  const q = query.trim().toLowerCase();
  if (!q) return parentCandidates(issues);
  return parentCandidates(issues).filter(issue =>
    issue.title.toLowerCase().includes(q) || issue.id.toLowerCase().includes(q)
  );
}
