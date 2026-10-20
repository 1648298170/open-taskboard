import { activeClaim, Issue, STATUSES, STATUS_CN, Status } from '../api';
import { DndContext, DragEndEvent, DragOverlay, DragStartEvent, PointerSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { buildLanes, buildBlockedByMap, flattenCardOrder, todayStr } from '../logic/board';
import { UserRound } from 'lucide-react';
import { fmtHMLocal } from '../logic/time';
import type { BlockedByMap } from '../logic/board';

// 纯逻辑已抽取到 ../logic/board（框架无关，node:test 可测）；此处 re-export
// 保持既有导入路径（App.tsx 从 Board 取 buildBlockedByMap/flattenCardOrder/todayStr）。
export { buildLanes, buildBlockedByMap, flattenCardOrder, todayStr };
export type { GroupBy, Lane } from '../logic/board';
import type { GroupBy } from '../logic/board';

/** 单个状态列：droppable 目标（dnd-kit），计数=顶层卡片组数。 */
function Column({ status, laneIssues, boardEmpty, onOpen, onDrop, blockedByMap, emptyHint,
  batchMode, selectedIds, onToggleSelect, cursorId }: {
  status: Status;
  laneIssues: Issue[];
  boardEmpty: boolean;
  onOpen: (id: string) => void;
  onDrop: (id: string, status: Status) => void;
  blockedByMap?: BlockedByMap;
  emptyHint?: string;
  batchMode: boolean;
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (id: string) => void;
  cursorId?: string | null;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const list = laneIssues.filter(i => i.status === status);
  const statusById = new Map(laneIssues.map(i => [i.id, i.status]));
  const hasUnmetDeps = (id: string): boolean =>
    (blockedByMap?.get(id) ?? []).some(dep => statusById.get(dep) !== 'done');
  return (
    <section ref={setNodeRef} className={`column${isOver ? ' drag-over' : ''}`} data-status={status}>
      <h2 className="column-heading">
        <span className={`dot ${status}`} aria-hidden="true" />{STATUS_CN[status] ?? status}
        {/* v0.4: 计数 = 顶层卡片组数（子任务嵌在父卡下，不计入本列）——
            数字与所见严格一致，杜绝「有数字没卡片」。 */}
        <span className="count">{list.filter(i => !i.parentId).length}</span>
      </h2>
      <div className="cards">
        {boardEmpty && emptyHint && <div className="column-empty">{emptyHint}</div>}
        {list.filter(i => !i.parentId).map(top => {
          // T5-25: 子任务进度（done/total + 点阵），从扁平 issues 列表
          // 中按 parentId 归属计算。
          const children = laneIssues.filter(c => c.parentId === top.id);
          const childProgress = children.length
            ? {
                done: children.filter(c => c.status === 'done').length,
                inProgress: children.filter(c => c.status === 'in_progress').length,
                total: children.length
              }
            : undefined;
          return (
            <div key={top.id} className="card-stack">
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
  // v0.4: dnd-kit —— PointerSensor 5px 激活阈值（点击不误拖），拖完回调
  // 既有 onDrop 契约（blocked 守卫 / done 整组确认都在 App 侧不变）。
  // DragOverlay：拖拽浮层副本（fixed 定位逃逸 .cards 的 overflow 裁剪，
  // 源卡留原位半透明）——否则卡片拖出本列边界即被遮挡。
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const handleDragStart = (e: DragStartEvent): void => setActiveId(String(e.active.id));
  const handleDragEnd = (e: DragEndEvent): void => {
    const { active, over } = e;
    if (over && active.id !== over.id) onDrop(String(active.id), String(over.id) as Status);
    setActiveId(null);
  };
  const handleDragCancel = (): void => setActiveId(null);
  const activeIssue = activeId ? issues.find(i => i.id === activeId) ?? null : null;
  const renderColumns = (laneIssues: Issue[]): JSX.Element[] =>
    STATUSES.map(s => (
      <Column key={s} status={s} laneIssues={laneIssues} boardEmpty={issues.length === 0}
        onOpen={onOpen} onDrop={onDrop} blockedByMap={blockedByMap} emptyHint={emptyHint}
        batchMode={batchMode} selectedIds={selectedIds} onToggleSelect={onToggleSelect} cursorId={cursorId} />
    ));

  // 无分组：保持原单网格 DOM（main.board 直接承载四列）。
  if (groupBy === 'none') {
    return (
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={handleDragCancel}>
        <main className="board">{renderColumns(issues)}</main>
        <DragOverlay>{activeIssue ? <CardView issue={activeIssue} child={!!activeIssue.parentId} overlay /> : null}</DragOverlay>
      </DndContext>
    );
  }

  // T5-27: 泳道布局 —— 每条泳道一个带标题的小节，内含完整四列网格。
  const lanes = buildLanes(issues, groupBy);
  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={handleDragCancel}>
      <main className="board grouped">
        {lanes.length === 0 && emptyHint && <div className="column-empty board-empty">{emptyHint}</div>}
        {lanes.map(lane => (
          <section key={lane.key || '(none)'} className="lane">
            <h2 className="lane-title">
              <span className="lane-glyph">▙</span>{lane.title}
              <span className="count">{lane.issues.filter(i => !i.parentId).length}</span>
            </h2>
            <div className="lane-grid">
              {renderColumns(lane.issues)}
            </div>
          </section>
        ))}
      </main>
      <DragOverlay>{activeIssue ? <CardView issue={activeIssue} child={!!activeIssue.parentId} overlay /> : null}</DragOverlay>
    </DndContext>
  );
}

/** 截止徽章：逾期 → 红色「逾期 MM-DD」；今日 → 琥珀「今日截止」；未来 → 灰色 MM-DD。 */
function DuePill({ dueDate }: { dueDate: string }) {
  const today = todayStr();
  const cls = dueDate < today ? 'overdue' : dueDate === today ? 'today' : 'future';
  const label = dueDate < today ? `逾期 ${dueDate.slice(5)}` : dueDate === today ? '今日截止' : dueDate.slice(5);
  return <span className={`due-pill ${cls}`}>{label}</span>;
}

/** T5-25: 父卡片子任务进度 — `2/5 ●◐○○○`：● done / ◐ in_progress / ○ 其余。 */
function ChildProgress({ done, inProgress, total }: { done: number; inProgress: number; total: number }) {
  const percent = total > 0 ? Math.round(done / total * 100) : 0;
  return (
    <div className="child-progress" title={`子任务：${done}/${total} 完成，${inProgress} 个进行中`}>
      <span className="child-progress-label">{done}/{total} 子任务</span>
      <span className="child-progress-track" aria-hidden="true">
        <span className="child-progress-fill" style={{ width: `${percent}%` }} />
      </span>
      {inProgress > 0 && <span className="child-progress-running">{inProgress} 进行中</span>}
    </div>
  );
}

/** T7-34: 有效租约（未过期）时显示认领人 + 剩余分钟；过期租约不显示。 */
function ClaimBadge({ issue }: { issue: Issue }) {
  const holder = activeClaim(issue);
  if (holder === null || issue.leaseExpiresAt === null) return null;
  const minutes = Math.max(0, Math.ceil((Date.parse(issue.leaseExpiresAt) - Date.now()) / 60_000));
  return (
    <span className="claim-badge" title={`认领人 ${holder}，租约至 ${fmtHMLocal(issue.leaseExpiresAt ?? '')}`}>
      <UserRound size={12} /> {holder} · {minutes}m
    </span>
  );
}

/** 卡片纯展示（Card 与 DragOverlay 浮层共用）。 */
function CardView({ issue, child, locked, childProgress, active, overlay,
  domRef, listeners, attributes, style, className, onClick, children }: {
  issue: Issue;
  child?: boolean;
  locked?: boolean;
  childProgress?: { done: number; inProgress: number; total: number };
  active?: boolean;
  /** DragOverlay 模式：无拖拽句柄，带浮层阴影。 */
  overlay?: boolean;
  domRef?: (el: HTMLElement | null) => void;
  listeners?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  style?: CSSProperties;
  className?: string;
  onClick?: () => void;
  children?: ReactNode;
}) {
  const priorityLabel: Record<string, string> = {
    urgent: '紧急',
    high: '高',
    medium: '普通',
    low: '低'
  };
  return (
    <article ref={domRef}
      aria-label={`任务：${issue.title}`}
      className={`card${active ? ' card-active' : ''}${className ?? ''}${overlay ? ' overlay' : ''}`}
      data-status={issue.status}
      data-card-id={issue.id}
      style={{ ...(child && !overlay ? { marginLeft: 18 } : {}), ...(style ?? {}) }}
      {...(listeners ?? {})}
      {...(attributes ?? {})}
      onClick={onClick}>
      {children}
      <div className="card-title-row">
        <span className="card-status-mark" data-status={issue.status} aria-hidden="true" />
        <div className="card-title">{child ? <span className="card-child-prefix">↳ </span> : null}{issue.title}</div>
      </div>
      {!child && childProgress && <ChildProgress done={childProgress.done} inProgress={childProgress.inProgress} total={childProgress.total} />}
      <div className="card-meta">
        {locked && <span className="dep-lock" title="被未完成的依赖阻塞">阻塞</span>}
        {!overlay && <ClaimBadge issue={issue} />}
        <span className={`badge ${issue.priority}`} title={`优先级：${priorityLabel[issue.priority] ?? issue.priority}`}>{priorityLabel[issue.priority] ?? issue.priority}</span>
        {issue.dueDate && <DuePill dueDate={issue.dueDate} />}
        <span className="card-id">#{issue.id}</span>
      </div>
    </article>
  );
}

function Card({ issue, child, onOpen, locked, childProgress, batchMode, checked, onToggleSelect, active }: {
  issue: Issue;
  child?: boolean;
  onOpen: (id: string) => void;
  locked?: boolean;
  childProgress?: { done: number; inProgress: number; total: number };
  batchMode?: boolean;
  checked?: boolean;
  onToggleSelect?: (id: string) => void;
  active?: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: issue.id,
    disabled: batchMode === true
  });
  return (
    <CardView issue={issue} child={child} locked={locked} childProgress={childProgress} active={active}
      domRef={setNodeRef} listeners={{ ...listeners }} attributes={{ ...attributes }}
      className={isDragging ? ' dragging' : ''}
      style={isDragging ? { opacity: 0.45 } : undefined}
      onClick={() => {
        // 批量模式下点卡片 = 切换选中，避免误开抽屉。
        if (batchMode) onToggleSelect?.(issue.id);
        else onOpen(issue.id);
      }}>
      {batchMode && onToggleSelect && (
        <label className="card-check" title="选中"
          onClick={e => e.stopPropagation()}
          onMouseDown={e => e.stopPropagation()}>
          <input type="checkbox" checked={checked ?? false} onChange={() => onToggleSelect(issue.id)} />
        </label>
      )}
    </CardView>
  );
}
