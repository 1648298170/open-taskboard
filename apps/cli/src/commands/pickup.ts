// Smart task pickup (T4-20/21): `next` picks the single best ready issue,
// `ready` lists them all. Both hit the same server views (readyIssues).
// T7-34: --agent claims the caller's perspective — issues leased by OTHER
// agents are skipped (your own and expired leases stay eligible).
import { need, type Command } from './registry.js';
import { show, type IssueLike } from './issue.js';

interface ReadyQuery { issue: IssueLike | null }

export const nextCommand: Command = {
  summary: 'Pick the next best ready task of a project',
  usage: 'next --project ID [--assignee WHO] [--agent WHO]',
  async run(ctx) {
    const { api, flags } = ctx;
    need(!!flags.project, 'next --project ID [--assignee WHO] [--agent WHO]');
    const qs = new URLSearchParams();
    if (flags.assignee !== undefined) qs.set('assignee', String(flags.assignee));
    if (flags.agent !== undefined) qs.set('agent', String(flags.agent));
    const { issue } = await api('GET', `/api/projects/${flags.project}/next?${qs}`) as ReadyQuery;
    if (!issue) { console.log('没有就绪任务（依赖未完成或全部完成）'); return; }
    show(issue);
    const ready: IssueLike[] = await api('GET', `/api/projects/${flags.project}/ready?${qs}`);
    console.log(`\n\u001b[2m${ready.length} ready\u001b[0m`);
  }
};

export const readyCommand: Command = {
  summary: 'List ready tasks (deps done, not done itself)',
  usage: 'ready --project ID [--assignee WHO] [--agent WHO]',
  async run(ctx) {
    const { api, flags } = ctx;
    need(!!flags.project, 'ready --project ID [--assignee WHO] [--agent WHO]');
    const qs = new URLSearchParams();
    if (flags.assignee !== undefined) qs.set('assignee', String(flags.assignee));
    if (flags.agent !== undefined) qs.set('agent', String(flags.agent));
    const ready: IssueLike[] = await api('GET', `/api/projects/${flags.project}/ready?${qs}`);
    if (!ready.length) { console.log('没有就绪任务（依赖未完成或全部完成）'); return; }
    ready.forEach((i, n) => console.log(
      `${n + 1}. #${i.id} [${String(i.status).padEnd(11)}] (${String(i.priority).padEnd(6)}) ${i.title}`
    ));
  }
};
