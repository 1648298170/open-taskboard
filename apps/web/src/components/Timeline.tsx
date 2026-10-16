import { useMemo } from 'react';
import { Issue } from '../api';

/** T7-37 轻量时间线（甘特 lite）。
 *
 * 数据源与看板同一条 listIssues（含 startDate/dueDate/status/priority），
 * 纯前端渲染：有任一日期的任务一行，条形横跨共享日期轴；点击行打开抽屉。
 * - 排序：dueDate 升序（无 dueDate 用 startDate）→ 优先级 urgent>high>medium>low → createdAt
 * - 颜色：逾期（dueDate < 今天且未 done）红 · 今日截止琥珀 · done 灰 · 其余 accent 渐变
 * - 仅 startDate 无 dueDate：条形延伸到今天（“已开工、未排期”的语义）
 * - 上限 50 行（超出显示弱化提示）
 */
const DAY_MS = 86_400_000;
const MAX_ROWS = 50;

/** 与 due-pill 一致的今天口径：本地时区 YYYY-MM-DD（ISO 日期串可安全字典序比较）。 */
const localToday = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const PRIORITY_RANK: Record<Issue['priority'], number> = { urgent: 0, high: 1, medium: 2, low: 3 };

type BarKind = 'normal' | 'overdue' | 'today' | 'done';

const barKind = (issue: Issue, today: string): BarKind => {
  if (issue.status === 'done') return 'done';
  if (issue.dueDate !== null) {
    if (issue.dueDate < today) return 'overdue';
    if (issue.dueDate === today) return 'today';
  }
  return 'normal';
};

export function Timeline({ issues, onOpen }: { issues: Issue[]; onOpen: (id: string) => void }) {
  const today = useMemo(localToday, []);

  const dated = useMemo(() => issues.filter(i => i.startDate !== null || i.dueDate !== null), [issues]);

  const rows = useMemo(() => {
    const sorted = [...dated].sort((a, b) => {
      const ka = a.dueDate ?? a.startDate ?? '';
      const kb = b.dueDate ?? b.startDate ?? '';
      if (ka !== kb) return ka < kb ? -1 : 1;
      const pa = PRIORITY_RANK[a.priority], pb = PRIORITY_RANK[b.priority];
      if (pa !== pb) return pa - pb;
      return Date.parse(a.createdAt) - Date.parse(b.createdAt);
    });
    return sorted.slice(0, MAX_ROWS);
  }, [dated]);

  // 共享日期轴：可见日期的 [min-1天, max+1天]。日期取值含 startDate 与
  // dueDate 两端，因此“仅 startDate”的任务也能撑起轴的范围。
  const axis = useMemo(() => {
    const dates: string[] = [];
    for (const i of dated) {
      if (i.startDate !== null) dates.push(i.startDate);
      if (i.dueDate !== null) dates.push(i.dueDate);
    }
    if (dates.length === 0) return null;
    dates.sort();
    const min = dates[0]!;
    const max = dates[dates.length - 1]!;
    const startMs = Date.parse(min) - DAY_MS;
    const endMs = Date.parse(max) + DAY_MS;
    const span = Math.max(endMs - startMs, DAY_MS);
    const pct = (ms: number): number => ((ms - startMs) / span) * 100;
    return { startMs, endMs, span, pct, min, max };
  }, [dated]);

  if (axis === null) {
    return <div className="timeline-empty">没有设置日期的任务</div>;
  }

  const todayMs = Date.parse(today);
  const todayVisible = todayMs >= axis.startMs && todayMs <= axis.endMs;
  const todayPct = axis.pct(todayMs + DAY_MS / 2); // 画在“今天”这一天的正中

  return (
    <section className="timeline" aria-label="时间线视图">
      <div className="tl-legend" aria-hidden="true">
        <span><i className="tl-dot normal" />正常</span>·
        <span><i className="tl-dot overdue" />逾期</span>·
        <span><i className="tl-dot today" />今日截止</span>·
        <span><i className="tl-dot done" />已完成</span>
      </div>
      {/* 轴头：两端日期 + 今天标注（与每行的今天竖线同百分比，拼成一条连续参考线）。 */}
      <div className="tl-row tl-head" aria-hidden="true">
        <span className="tl-label">日期轴</span>
        <span className="tl-axis">
          {todayVisible && (
            <span className="tl-today-line" style={{ left: `${todayPct}%` }}>
              <i className="tl-today-tag">今天</i>
            </span>
          )}
          <span className="tl-tick" style={{ left: 0 }}>{axis.min.slice(5)}</span>
          <span className="tl-tick" style={{ right: 0 }}>{axis.max.slice(5)}</span>
        </span>
      </div>
      {rows.map(i => {
        // 日期按“整天”计：条形覆盖 [start, end+1天)，仅 dueDate 时退化为 1 天点条。
        const startMs = Date.parse(i.startDate ?? i.dueDate!);
        const endMs = i.dueDate !== null
          ? Date.parse(i.dueDate)
          : Math.max(Date.parse(i.startDate!), todayMs); // 仅 startDate → 延伸到今天
        const left = axis.pct(startMs);
        const width = Math.max(axis.pct(endMs + DAY_MS) - left, 0);
        const kind = barKind(i, today);
        const tip = i.dueDate !== null
          ? `${i.startDate ?? '?'} → ${i.dueDate} · [${i.status}]`
          : `start ${i.startDate} · [${i.status}]`;
        return (
          <div key={i.id} className="tl-row" onClick={() => onOpen(i.id)} title={tip}>
            <span className="tl-label">#{i.id} {i.title}</span>
            <span className="tl-axis">
              {todayVisible && <span className="tl-today-line" style={{ left: `${todayPct}%` }} />}
              <span className={`tl-bar ${kind}`} style={{ left: `${left}%`, width: `${width}%` }} />
            </span>
          </div>
        );
      })}
      {dated.length > MAX_ROWS && <div className="tl-more">仅显示前 {MAX_ROWS} 条（共 {dated.length} 条带日期任务）</div>}
    </section>
  );
}
