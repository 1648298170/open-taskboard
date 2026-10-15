import { need, type Command } from './registry.js';

export const progressCommand: Command = {
  summary: 'Show progress stats for a project',
  usage: 'progress --project ID',
  async run(ctx) {
    const { api, flags } = ctx;
    need(!!flags.project, 'progress --project ID');
    const pr = await api('GET', `/api/projects/${flags.project}/progress`);
    console.log(`issues: ${pr.done}/${pr.total} done | top-level: ${pr.topDone}/${pr.topTotal} | weighted(父任务等权): ${pr.weightedDone}/${pr.weightedTotal}`);
  }
};
