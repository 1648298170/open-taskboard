// 看板纯逻辑（框架无关，node:test 直接可测）。Board.tsx 只做渲染，
// 分组/排序/日期比较全部住在这里。
import { STATUSES } from '../api';
import type { DependencyEdge, Issue } from '../api';

/** issueId → 该 issue 被 whom 阻塞（blocked-by id 列表），由项目依赖边聚合而来。 */
export type BlockedByMap = Map<string, string[]>;

export function buildBlockedByMap(edges: DependencyEdge[]): BlockedByMap {
  const map: BlockedByMap = new Map();
  for (const e of edges) {
    const list = map.get(e.issueId);
    if (list) list.push(e.dependsOnId);
    else map.set(e.issueId, [e.dependsOnId]);
  }
  return map;
}

/** T5-27: 泳道分组维度。 */
export type GroupBy = 'none' | 'assignee' | 'label';

export interface Lane {
  key: string;
  title: string;
  issues: Issue[];
}

/** T5-27: 泳道划分 —— 子任务跟随顶层父任务所在泳道（按顶层 issue 的
 * 负责人/标签归组）。'none' → 单泳道（无标题，等价于原四列网格）；
 * 多标签任务在每个标签泳道各出现一次；未分配/无标签泳道固定排在最后。 */
export function buildLanes(issues: Issue[], groupBy: GroupBy): Lane[] {
  if (groupBy === 'none') return [{ key: '', title: '', issues }];
  const named: Lane[] = [];
  const byKey = new Map<string, Lane>();
  const fallback: Lane = { key: '', title: groupBy === 'assignee' ? '未分配' : '无标签', issues: [] };
  const laneFor = (key: string): Lane => {
    let lane = byKey.get(key);
    if (!lane) {
      lane = { key, title: key, issues: [] };
      byKey.set(key, lane);
      named.push(lane);
    }
    return lane;
  };
  for (const top of issues) {
    if (top.parentId) continue;
    const children = issues.filter(i => i.parentId === top.id);
    if (groupBy === 'assignee') {
      (top.assignee ? laneFor(top.assignee) : fallback).issues.push(top, ...children);
    } else {
      const labels = top.labels.split(',').map(s => s.trim()).filter(s => s.length > 0);
      if (labels.length === 0) fallback.issues.push(top, ...children);
      else for (const lb of labels) laneFor(lb).issues.push(top, ...children);
    }
  }
  return fallback.issues.length ? [...named, fallback] : named;
}

/** T5-29: 可见卡片按渲染顺序展开的扁平 id 序列（j/k 键盘导航用）。
 * 顺序与 Board 渲染一致：泳道 → 状态列 → 父卡片及其下子卡片。 */
export function flattenCardOrder(issues: Issue[], groupBy: GroupBy): string[] {
  const out: string[] = [];
  for (const lane of buildLanes(issues, groupBy)) {
    for (const status of STATUSES) {
      for (const top of lane.issues.filter(i => !i.parentId && i.status === status)) {
        out.push(top.id);
        for (const c of lane.issues) if (c.parentId === top.id) out.push(c.id);
      }
    }
  }
  return out;
}

/** 本地时区的今天，YYYY-MM-DD —— 与 dueDate 直接字符串比较。 */
export function todayStr(): string {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}
