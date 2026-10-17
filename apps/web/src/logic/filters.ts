// 工具栏过滤的纯逻辑（框架无关）：文本 / 负责人 / 标签 / 逾期·今日截止的
// 组合匹配。due 语义与 DuePill 同款纯字符串日期比较（本地时区今天）。
import type { Issue } from '../api';

export interface IssueFilters {
  text: string;
  assignee: string;
  label: string;
  due: '' | 'overdue' | 'today';
}

export function issueMatchesFilters(issue: Issue, f: IssueFilters, today: string): boolean {
  const q = f.text.trim().toLowerCase();
  return (!q || issue.title.toLowerCase().includes(q) || issue.description.toLowerCase().includes(q))
    && (!f.assignee || issue.assignee === f.assignee)
    && (!f.label || issue.labels.split(',').map(s => s.trim()).includes(f.label))
    && (!f.due || (issue.dueDate !== null
      && (f.due === 'overdue' ? issue.dueDate < today : issue.dueDate === today)));
}
