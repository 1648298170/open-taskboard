import { need, type Command } from './registry.js';
import { resolveTemplate } from './templates.js';

export interface IssueLike {
  id: string; projectId: string; parentId: string | null; title: string;
  status: string; priority: string; labels: string; branch: string;
  assignee: string; version: number; description: string;
  children?: IssueLike[]; comments?: { author: string; body: string }[];
  blockedBy?: string[]; blocks?: string[];
}

export const show = (i: IssueLike): void => {
  console.log(`#${i.id} [${i.status}] (${i.priority}) ${i.title}`);
  console.log(`  project: ${i.projectId}  parent: ${i.parentId ?? '-'}  branch: ${i.branch || '-'}  assignee: ${i.assignee || '-'}  labels: ${i.labels || '-'}  v${i.version}`);
  if (i.description) console.log(`\n${i.description}`);
};

export const issueCommands: Record<string, Command> = {
  'issue create': {
    summary: 'Create an issue',
    usage: 'issue create --project ID --title T [--template NAME] [--parent ID] [--worktree W] [--start-date D] [--due-date D]',
    async run(ctx) {
      const { api, flags } = ctx;
      // T4-23: --template NAME prefills fields from <dataDir>/templates.json.
      // Merge rule: explicit flags win entirely; the template only fills
      // fields the user omitted (title included — no prefixing).
      const tpl = flags.template !== undefined ? resolveTemplate(String(flags.template)) : {};
      const title = flags.title !== undefined ? String(flags.title) : tpl.title;
      need(!!flags.project && !!title, 'issue create --project ID --title T [--template NAME] [--parent ID]');
      const body: Record<string, unknown> = {
        parentId: flags.parent ?? null, title,
        description: flags.description ?? tpl.description ?? '',
        status: flags.status ?? tpl.status ?? 'todo',
        priority: flags.priority ?? tpl.priority ?? 'medium',
        labels: flags.labels ?? tpl.labels ?? '',
        branch: flags.branch ?? tpl.branch ?? '',
        assignee: flags.assignee ?? ''
      };
      if (flags.worktree !== undefined) body.worktree = String(flags.worktree);
      if (flags['start-date'] !== undefined) body.startDate = String(flags['start-date']);
      if (flags['due-date'] !== undefined) body.dueDate = String(flags['due-date']);
      const i = await api('POST', `/api/projects/${flags.project}/issues`, body);
      console.log(`created #${i.id} [${i.status}] ${i.title}`);
    }
  },
  'issue list': {
    summary: 'List issues of a project',
    usage: 'issue list --project ID [--status S] [--parent ID|null] [--archived]',
    async run(ctx) {
      const { api, flags } = ctx;
      need(!!flags.project, 'issue list --project ID');
      const qs = new URLSearchParams();
      if (flags.status) qs.set('status', String(flags.status));
      if (flags.parent) qs.set('parentId', String(flags.parent));
      // T5-24: --archived → archived=only (default already excludes archived).
      if (flags.archived) qs.set('archived', 'only');
      for (const i of await api('GET', `/api/projects/${flags.project}/issues?${qs}`)) {
        console.log(`#${i.id} [${String(i.status).padEnd(11)}] (${String(i.priority).padEnd(6)}) ${i.parentId ? '  └ ' : ''}${i.title}${i.branch ? `  ⟂ ${i.branch}` : ''}`);
      }
    }
  },
  'issue show': {
    summary: 'Show one issue with children, dependencies and comments',
    usage: 'issue show ID',
    async run(ctx) {
      const { api, rest } = ctx;
      need(!!rest[0], 'issue show ID');
      const i: IssueLike = await api('GET', `/api/issues/${rest[0]}`);
      show(i);
      if (i.blockedBy?.length || i.blocks?.length) {
        console.log('\n依赖:');
        if (i.blockedBy?.length) console.log(`  blocked-by: ${i.blockedBy.map(d => `#${d}`).join(' ')}`);
        if (i.blocks?.length) console.log(`  blocks:     ${i.blocks.map(d => `#${d}`).join(' ')}`);
      }
      if (i.children?.length) { console.log('\nchildren:'); i.children.forEach(c => console.log(`  #${c.id} [${c.status}] ${c.title}`)); }
      if (i.comments?.length) { console.log('\ncomments:'); i.comments.forEach(c => console.log(`  ${c.author || 'anon'}: ${c.body}`)); }
    }
  },
  'issue dep-add': {
    summary: 'Add a dependency: ID is blocked by --on DEPENDS_ON_ID',
    usage: 'issue dep-add ID --on DEPENDS_ON_ID',
    async run(ctx) {
      const { api, flags, rest } = ctx;
      need(!!rest[0] && !!flags.on && typeof flags.on === 'string', 'issue dep-add ID --on DEPENDS_ON_ID');
      await api('POST', `/api/issues/${rest[0]}/dependencies`, { dependsOnId: String(flags.on) });
      console.log(`#${rest[0]} now depends on #${flags.on}`);
    }
  },
  'issue dep-rm': {
    summary: 'Remove a dependency between two issues',
    usage: 'issue dep-rm ID --on DEPENDS_ON_ID',
    async run(ctx) {
      const { api, flags, rest } = ctx;
      need(!!rest[0] && !!flags.on && typeof flags.on === 'string', 'issue dep-rm ID --on DEPENDS_ON_ID');
      await api('DELETE', `/api/issues/${rest[0]}/dependencies/${flags.on}`);
      console.log(`#${rest[0]} no longer depends on #${flags.on}`);
    }
  },
  'issue dep-list': {
    summary: 'List dependencies of one issue (blocked-by / blocks)',
    usage: 'issue dep-list ID',
    async run(ctx) {
      const { api, rest } = ctx;
      need(!!rest[0], 'issue dep-list ID');
      const i: IssueLike = await api('GET', `/api/issues/${rest[0]}`);
      const blockedBy = i.blockedBy ?? [];
      const blocks = i.blocks ?? [];
      if (!blockedBy.length && !blocks.length) { console.log(`#${i.id}: no dependencies`); return; }
      if (blockedBy.length) console.log(`blocked-by: ${blockedBy.map(d => `#${d}`).join(' ')}`);
      if (blocks.length) console.log(`blocks:     ${blocks.map(d => `#${d}`).join(' ')}`);
    }
  },
  'issue update': {
    summary: 'Update issue fields (optimistic lock via --expected-version)',
    usage: 'issue update ID [flags] [--start-date D] [--due-date D]',
    async run(ctx) {
      const { api, flags, rest } = ctx;
      need(!!rest[0], 'issue update ID [flags]');
      // [flag name, body key] pairs — the writable-field whitelist.
      const fields: [string, string][] = [
        ['title', 'title'], ['status', 'status'], ['priority', 'priority'], ['branch', 'branch'],
        ['worktree', 'worktree'],
        ['labels', 'labels'], ['assignee', 'assignee'], ['description', 'description'],
        ['start-date', 'startDate'], ['due-date', 'dueDate']
      ];
      const body: Record<string, unknown> = Object.fromEntries(
        fields.filter(([f]) => flags[f] !== undefined).map(([f, k]) => [k, flags[f]])
      );
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
  },
  'issue archive': {
    summary: 'Archive an issue (hides it from board/ready/progress; see issue list --archived)',
    usage: 'issue archive ID',
    async run(ctx) {
      const { api, rest } = ctx;
      need(!!rest[0], 'issue archive ID');
      await api('POST', `/api/issues/${rest[0]}/archive`, {});
      console.log(`archived #${rest[0]}`);
    }
  },
  'issue unarchive': {
    summary: 'Unarchive an issue (restores it to the board)',
    usage: 'issue unarchive ID',
    async run(ctx) {
      const { api, rest } = ctx;
      need(!!rest[0], 'issue unarchive ID');
      await api('POST', `/api/issues/${rest[0]}/unarchive`, {});
      console.log(`unarchived #${rest[0]}`);
    }
  }
};
