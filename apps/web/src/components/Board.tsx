import { activeClaim, DependencyEdge, Issue, STATUSES, Status } from '../api';

/** issueId → 该 issue 被 whom 阻塞（blocked-by id 列表），由项目依赖边聚合而来。 */
export type BlockedByMap = Map<string, string[]>;

/** T5-27: 泳道分组维度。 */
export type GroupBy = 'none' | 'assignee' | 'label';

export interface Lane {
  key: string;
  title: string;
  issues: Issue[];
}

export function buildBlockedByMap(edges: DependencyEdge[]): BlockedByMap {
  const map: BlockedByMap = new Map();
  for (const e of edges) {
    const list = map.get(e.issueId);
    if (list) list.push(e.dependsOnId);
    else map.set(e.issueId, [e.dependsOnId]);
  }
  return map;
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

export function Board({ issues, onOpen, onDrop, emptyHint, blockedByMap, groupBy = 'none',
  batchMode = false, selectedIds, onToggleSelect, cursorId }: {
  issues: Issue[];
  onOpen: (id: string) => void;
  onDrop: (id: string, status: Status) => void;
  /** 过滤命中 0 张卡片时列内显示的提示文案 */
  emptyHint?: string;
  /** 依赖聚合：用于卡片上的 🔒（存在未完成 blocked-by） */
  blockedByMap?: BlockedByMap;
  /** T5-27: 泳道分组维度，默认 'none'（单四列网格）。 */
  groupBy?: GroupBy;
  /** T5-26: 批量模式 —— 卡片显示复选框，点卡片切换选中而非打开。 */
  batchMode?: boolean;
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (id: string) => void;
  /** T5-29: j/k 高亮的卡片 id（.card-active 外框）。 */
  cursorId?: string | null;
}) {
  const statusById = new Map(issues.map(i => [i.id, i.status]));
  const hasUnmetDeps = (id: string): boolean =>
    (blockedByMap?.get(id) ?? []).some(dep => statusById.get(dep) !== 'done');

  // 四列网格渲染抽成局部函数：单网格与泳道两种布局共用，避免复制粘贴。
  const renderColumn = (status: Status, laneIssues: Issue[]) => {
    const list = laneIssues.filter(i => i.status === status);
    return (
      <section key={status} className="column" data-status={status}
        onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }}
        onDragLeave={e => e.currentTarget.classList.remove('drag-over')}
        onDrop={e => {
          e.preventDefault();
          e.currentTarget.classList.remove('drag-over');
          onDrop(e.dataTransfer.getData('text/plain'), status);
        }}>
        <h2>
          <span className={`dot ${status}`} />{status}
          <span className="count">{list.length}</span>
        </h2>
        <div className="cards">
          {issues.length === 0 && emptyHint && <div className="column-empty">{emptyHint}</div>}
          {list.filter(i => !i.parentId).map(top => {
            // T5-25: 子任务进度（done/total + 点阵），从扁平 issues 列表
            // 中按 parentId 归属计算。
            const children = laneIssues.filter(c => c.parentId === top.id);
            const childProgress = children.length
              ? { done: children.filter(c => c.status === 'done').length, total: children.length }
              : undefined;
            return (
              <div key={top.id}>
                <Card issue={top} onOpen={onOpen} locked={hasUnmetDeps(top.id)} childProgress={childProgress}
                  batchMode={batchMode} checked={selectedIds?.has(top.id) ?? false}
                  onToggleSelect={onToggleSelect} active={cursorId === top.id} />
                {children.map(child =>
                  <Card key={child.id} issue={child} child onOpen={onOpen} locked={hasUnmetDeps(child.id)}
                    batchMode={batchMode} checked={selectedIds?.has(child.id) ?? false}
                    onToggleSelect={onToggleSelect} active={cursorId === child.id} />)}
              </div>
            );
          })}
        </div>
      </section>
    );
  };

  // 无分组：保持原单网格 DOM（main.board 直接承载四列）。
  if (groupBy === 'none') {
    return <main className="board">{STATUSES.map(s => renderColumn(s, issues))}</main>;
  }

  // T5-27: 泳道布局 —— 每条泳道一个带标题的小节，内含完整四列网格。
  const lanes = buildLanes(issues, groupBy);
  return (
    <main className="board grouped">
      {lanes.length === 0 && emptyHint && <div className="column-empty board-empty">{emptyHint}</div>}
      {lanes.map(lane => (
        <section key={lane.key || '(none)'} className="lane">
          <h2 className="lane-title">
            <span className="lane-glyph">▙</span>{lane.title}
            <span className="count">{lane.issues.filter(i => !i.parentId).length}</span>
          </h2>
          <div className="lane-grid">
            {STATUSES.map(s => renderColumn(s, lane.issues))}
          </div>
        </section>
      ))}
    </main>
  );
}

/** 本地时区的今天，YYYY-MM-DD —— 与 dueDate 直接字符串比较。 */
export function todayStr(): string {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

/** 截止徽章：逾期 → 红色「逾期 MM-DD」；今日 → 琥珀「今日截止」；未来 → 灰色 MM-DD。 */
function DuePill({ dueDate }: { dueDate: string }) {
  const today = todayStr();
  const cls = dueDate < today ? 'overdue' : dueDate === today ? 'today' : 'future';
  const label = dueDate < today ? `逾期 ${dueDate.slice(5)}` : dueDate === today ? '今日截止' : dueDate.slice(5);
  return <span className={`due-pill ${cls}`}>{label}</span>;
}

/** T5-25: 父卡片子任务进度 — `2/5 ●●●○○`，● 用 accent，○ 弱化。 */
function ChildProgress({ done, total }: { done: number; total: number }) {
  return (
    <div className="child-progress" title={`子任务 ${done}/${total} done`}>
      {done}/{total}{' '}
      {Array.from({ length: total }, (_, i) =>
        <span key={i} className={i < done ? 'dot-on' : 'dot-off'}>{i < done ? '●' : '○'}</span>)}
    </div>
  );
}

/** T7-34: 有效租约（未过期）时显示认领人 + 剩余分钟；过期租约不显示。 */
function ClaimBadge({ issue }: { issue: Issue }) {
  const holder = activeClaim(issue);
  if (holder === null || issue.leaseExpiresAt === null) return null;
  const minutes = Math.max(0, Math.ceil((Date.parse(issue.leaseExpiresAt) - Date.now()) / 60_000));
  return (
    <span className="claim-badge" title={`认领人 ${holder}，租约至 ${issue.leaseExpiresAt}`}>
      👤 {holder} · {minutes}m
    </span>
  );
}

function Card({ issue, child, onOpen, locked, childProgress, batchMode, checked, onToggleSelect, active }: {
  issue: Issue;
  child?: boolean;
  onOpen: (id: string) => void;
  locked?: boolean;
  childProgress?: { done: number; total: number };
  batchMode?: boolean;
  checked?: boolean;
  onToggleSelect?: (id: string) => void;
  active?: boolean;
}) {
  return (
    <article className={`card${active ? ' card-active' : ''}`} data-status={issue.status}
      data-card-id={issue.id}
      style={child ? { marginLeft: 18 } : undefined}
      draggable={!batchMode}
      onClick={() => {
        // 批量模式下点卡片 = 切换选中，避免误开抽屉。
        if (batchMode) onToggleSelect?.(issue.id);
        else onOpen(issue.id);
      }}
      onDragStart={e => {
        e.dataTransfer.setData('text/plain', issue.id);
        e.currentTarget.classList.add('dragging');
      }}
      onDragEnd={e => e.currentTarget.classList.remove('dragging')}>
      {batchMode && onToggleSelect && (
        <label className="card-check" title="选中"
          onClick={e => e.stopPropagation()}
          onMouseDown={e => e.stopPropagation()}>
          <input type="checkbox" checked={checked ?? false} onChange={() => onToggleSelect(issue.id)} />
        </label>
      )}
      <div className="card-title">{child ? '└ ' : ''}{issue.title}</div>
      {!child && childProgress && <ChildProgress done={childProgress.done} total={childProgress.total} />}
      <div className="card-meta">
        {locked && <span className="dep-lock" title="被未完成的依赖阻塞">🔒</span>}
        <ClaimBadge issue={issue} />
        <span className={`badge ${issue.priority}`}>{issue.priority}</span>
        {issue.dueDate && <DuePill dueDate={issue.dueDate} />}
        {issue.branch && <span className="badge branch">⟂ {issue.branch}</span>}
        {issue.worktree && <span className="wt-badge" title={`worktree: ${issue.worktree}`}>⎇ {issue.worktree}</span>}
        <span>#{issue.id}</span>
      </div>
    </article>
  );
}
