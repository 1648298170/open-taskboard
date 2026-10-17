import { activeClaim, Issue, STATUSES, Status } from '../api';
import { DndContext, DragEndEvent, PointerSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import { buildLanes, buildBlockedByMap, flattenCardOrder, todayStr } from '../logic/board';
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
      <h2>
        <span className={`dot ${status}`} />{status}
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
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const handleDragEnd = (e: DragEndEvent): void => {
    const { active, over } = e;
    if (over && active.id !== over.id) onDrop(String(active.id), String(over.id) as Status);
  };
  const renderColumns = (laneIssues: Issue[]): JSX.Element[] =>
    STATUSES.map(s => (
      <Column key={s} status={s} laneIssues={laneIssues} boardEmpty={issues.length === 0}
        onOpen={onOpen} onDrop={onDrop} blockedByMap={blockedByMap} emptyHint={emptyHint}
        batchMode={batchMode} selectedIds={selectedIds} onToggleSelect={onToggleSelect} cursorId={cursorId} />
    ));

  // 无分组：保持原单网格 DOM（main.board 直接承载四列）。
  if (groupBy === 'none') {
    return (
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <main className="board">{renderColumns(issues)}</main>
      </DndContext>
    );
  }

  // T5-27: 泳道布局 —— 每条泳道一个带标题的小节，内含完整四列网格。
  const lanes = buildLanes(issues, groupBy);
  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
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
  return (
    <div className="child-progress" title={`子任务 ${done}/${total} done · ${inProgress} 进行中`}>
      {done}/{total}{' '}
      {Array.from({ length: total }, (_, i) => {
        const cls = i < done ? 'dot-on' : i < done + inProgress ? 'dot-prog' : 'dot-off';
        const glyph = cls === 'dot-on' ? '●' : cls === 'dot-prog' ? '◐' : '○';
        return <span key={i} className={cls}>{glyph}</span>;
      })}
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
  childProgress?: { done: number; inProgress: number; total: number };
  batchMode?: boolean;
  checked?: boolean;
  onToggleSelect?: (id: string) => void;
  active?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: issue.id,
    disabled: batchMode === true
  });
  const style = {
    ...(child ? { marginLeft: 18 } : {}),
    ...(transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 30 } : {})
  };
  return (
    <article ref={setNodeRef} className={`card${active ? ' card-active' : ''}${isDragging ? ' dragging' : ''}`}
      data-status={issue.status}
      data-card-id={issue.id}
      style={style}
      {...listeners}
      {...attributes}
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
      <div className="card-title">{child ? '└ ' : ''}{issue.title}</div>
      {!child && childProgress && <ChildProgress done={childProgress.done} inProgress={childProgress.inProgress} total={childProgress.total} />}
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
