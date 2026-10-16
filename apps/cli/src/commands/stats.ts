// T6-31: `taskboard stats --project ID [--weeks 8]` — the stats panel in
// terminal form: weekly throughput bars (█), avg cycle, agent contributions,
// status breakdown. Same /api/projects/:id/stats endpoint the web panel uses.
import { need, type Command } from './registry.js';

interface StatsPayload {
  weeklyDone: { weekStart: string; count: number }[];
  avgCycleHours: number | null;
  byActor: { actor: string; actions: number }[];
  byStatus: { status: string; count: number }[];
}

export const statsCommand: Command = {
  summary: 'Show stats for a project (weekly throughput / avg cycle / agent contributions / status breakdown)',
  usage: 'stats --project ID [--weeks 8]',
  async run(ctx) {
    const { api, flags } = ctx;
    need(!!flags.project, 'stats --project ID [--weeks 8]');
    const weeks = Number.parseInt(String(flags.weeks ?? '8'), 10);
    need(Number.isFinite(weeks), 'stats --project ID [--weeks 8]');
    const s: StatsPayload = await api('GET', `/api/projects/${flags.project}/stats?weeks=${weeks}`);

    console.log(`周吞吐（近 ${s.weeklyDone.length} 周）:`);
    const max = Math.max(...s.weeklyDone.map(w => w.count), 1);
    for (const w of s.weeklyDone) {
      const bar = '█'.repeat(Math.round((w.count / max) * 24));
      console.log(`  ${w.weekStart}  ${String(w.count).padStart(3)} ${bar}`);
    }
    console.log(`平均周期: ${s.avgCycleHours === null ? '暂无完成任务' : `${s.avgCycleHours} h`}`);
    console.log('Agent 贡献:');
    if (s.byActor.length === 0) console.log('  暂无记录');
    for (const a of s.byActor) console.log(`  ${a.actor}  ${a.actions}`);
    console.log(`状态分布: ${s.byStatus.map(x => `${x.status} ${x.count}`).join(' · ')}`);
  }
};
