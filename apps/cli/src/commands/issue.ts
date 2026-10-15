import { need, type Command } from './registry.js';

interface IssueLike {
  id: string; projectId: string; parentId: string | null; title: string;
  status: string; priority: string; labels: string; branch: string;
  assignee: string; version: number; description: string;
  children?: IssueLike[]; comments?: { author: string; body: string }[];
}

const show = (i: IssueLike): void => {
  console.log(`#${i.id} [${i.status}] (${i.priority}) ${i.title}`);
  console.log(`  project: ${i.projectId}  parent: ${i.parentId ?? '-'}  branch: ${i.branch || '-'}  assignee: ${i.assignee || '-'}  labels: ${i.labels || '-'}  v${i.version}`);
  if (i.description) console.log(`\n${i.description}`);
};

export const issueCommands: Record<string, Command> = {
  'issue create': {
    summary: 'Create an issue',
    usage: 'issue create --project ID --title T [--parent ID]',
    async run(ctx) {
      const { api, flags } = ctx;
      need(!!flags.project && !!flags.title, 'issue create --project ID --title T [--parent ID]');
      const i = await api('POST', `/api/projects/${flags.project}/issues`, {
        parentId: flags.parent ?? null, title: flags.title,
        description: flags.description ?? '', status: flags.status ?? 'todo',
        priority: flags.priority ?? 'medium', labels: flags.labels ?? '',
        branch: flags.branch ?? '', assignee: flags.assignee ?? ''
      });
      console.log(`created #${i.id} [${i.status}] ${i.title}`);
    }
  },
  'issue list': {
    summary: 'List issues of a project',
    usage: 'issue list --project ID [--status S] [--parent ID|null]',
    async run(ctx) {
      const { api, flags } = ctx;
      need(!!flags.project, 'issue list --project ID');
      const qs = new URLSearchParams();
      if (flags.status) qs.set('status', String(flags.status));
      if (flags.parent) qs.set('parentId', String(flags.parent));
      for (const i of await api('GET', `/api/projects/${flags.project}/issues?${qs}`)) {
        console.log(`#${i.id} [${String(i.status).padEnd(11)}] (${String(i.priority).padEnd(6)}) ${i.parentId ? '  └ ' : ''}${i.title}${i.branch ? `  ⟂ ${i.branch}` : ''}`);
      }
    }
  },
  'issue show': {
    summary: 'Show one issue with children and comments',
    usage: 'issue show ID',
    async run(ctx) {
      const { api, rest } = ctx;
      need(!!rest[0], 'issue show ID');
      const i: IssueLike = await api('GET', `/api/issues/${rest[0]}`);
      show(i);
      if (i.children?.length) { console.log('\nchildren:'); i.children.forEach(c => console.log(`  #${c.id} [${c.status}] ${c.title}`)); }
      if (i.comments?.length) { console.log('\ncomments:'); i.comments.forEach(c => console.log(`  ${c.author || 'anon'}: ${c.body}`)); }
    }
  },
  'issue update': {
    summary: 'Update issue fields (optimistic lock via --expected-version)',
    usage: 'issue update ID [flags]',
    async run(ctx) {
      const { api, flags, rest } = ctx;
      need(!!rest[0], 'issue update ID [flags]');
      const body: Record<string, unknown> = Object.fromEntries(['title', 'status', 'priority', 'branch', 'labels', 'assignee', 'description']
        .filter(k => flags[k] !== undefined).map(k => [k, flags[k]]));
      if (flags['expected-version'] !== undefined) body.version = Number(flags['expected-version']);
      const i = await api('PATCH', `/api/issues/${rest[0]}`, body);
      console.log(`#${i.id} updated (v${i.version})`);
    }
  },
  'issue done': {
    summary: 'Mark an issue done (optimistic lock via --expected-version)',
    usage: 'issue done ID [flags]',
    async run(ctx) {
      const { api, flags, rest } = ctx;
      need(!!rest[0], 'issue done ID [flags]');
      const body: Record<string, unknown> = { status: 'done' };
      if (flags['expected-version'] !== undefined) body.version = Number(flags['expected-version']);
      const i = await api('PATCH', `/api/issues/${rest[0]}`, body);
      console.log(`#${i.id} → done (v${i.version})`);
    }
  },
  'issue delete': {
    summary: 'Delete an issue',
    usage: 'issue delete ID',
    async run(ctx) {
      const { api, rest } = ctx;
      need(!!rest[0], 'issue delete ID');
      await api('DELETE', `/api/issues/${rest[0]}`);
      console.log(`deleted #${rest[0]}`);
    }
  }
};
