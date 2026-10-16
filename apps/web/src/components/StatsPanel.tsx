import { STATUSES, Stats } from '../api';

/** `2026-10-12` → `10-12`（周标签紧凑显示）。 */
const mmdd = (iso: string): string => iso.slice(5);

/**
 * T6-31: 统计面板 —— 周吞吐 / 平均周期 / Agent 贡献 / 状态分布。
 * 数据由 App 拉取后传入（打开面板与每次 refresh 时重取）。
 */
export function StatsPanel({ stats }: { stats: Stats | null }) {
  if (!stats) return null;
  const max = Math.max(...stats.weeklyDone.map(w => w.count), 1);
  const statusCount = new Map(stats.byStatus.map(s => [s.status as string, s.count]));
  return (
    <section className="stats-panel" aria-label="项目统计">
      <div className="stats-block stats-weekly">
        <h3>周吞吐（近 {stats.weeklyDone.length} 周）</h3>
        <div>
          {stats.weeklyDone.map(w => (
            <div key={w.weekStart} className="stats-bar-row" title={`${w.weekStart}: ${w.count}`}>
              <span className="stats-bar-label">{mmdd(w.weekStart)}</span>
              <span className="stats-bar-track">
                <span className="stats-bar" style={{ width: `${(w.count / max) * 100}%` }} />
              </span>
              <span className="stats-bar-count">{w.count}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="stats-block">
        <h3>平均周期</h3>
        <p className="stats-metric">
          {stats.avgCycleHours === null ? '暂无完成任务' : `${stats.avgCycleHours} h`}
        </p>
      </div>
      <div className="stats-block">
        <h3>Agent 贡献</h3>
        {stats.byActor.length === 0
          ? <p className="stats-metric dim">暂无记录</p>
          : (
            <ol className="stats-actors">
              {stats.byActor.map(a => (
                <li key={a.actor} className="stats-row">
                  <span className="stats-actor" title={a.actor}>{a.actor}</span>
                  <span className="stats-actor-count">{a.actions}</span>
                </li>
              ))}
            </ol>
          )}
      </div>
      <div className="stats-block">
        <h3>状态分布</h3>
        <div className="stats-chips">
          {STATUSES.map(s => (
            <span key={s} className={`stats-chip ${s}`}>
              <span className={`dot ${s}`} />{s} {statusCount.get(s) ?? 0}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
