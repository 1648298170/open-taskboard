import { need, seg, type Command } from './registry.js';

export const projectCommands: Record<string, Command> = {
  'project create': {
    summary: 'Create a project',
    usage: 'project create --name NAME [--id ID] [--wake-port PORT] [--labels LIST]',
    async run(ctx) {
      const { api, flags } = ctx;
      need(!!flags.name, 'project create --name NAME [--id ID] [--wake-port PORT] [--labels LIST]');
      const port = String(flags['wake-port'] ?? '').trim();
      const p = await api('POST', '/api/projects', {
        id: flags.id, name: flags.name, workspacePath: flags['workspace-path'] ?? '', ...(port ? { wakeChannel: `http://127.0.0.1:${port}` } : {}), ...(flags.labels ? { labels: String(flags.labels) } : {}),
      });
      console.log(`created project ${p.id} (${p.name})${p.wakeChannel ? ` — wake → ${p.wakeChannel}` : ''}`);
      if (!p.wakeChannel) return;
      console.log(`opencode serve --port ${port} &                # 常驻一次`);
      console.log(`opencode attach ${p.wakeChannel}   # 日常唯一命令`);
    }
  },
  'project set': {
    summary: 'Update project name / wake channel binding',
    usage: 'project set --id ID [--name NAME] [--wake-port PORT] [--labels LIST] [--wake-port 0 TO CLEAR]',
    async run(ctx) {
      const { api, flags } = ctx;
      need(!!flags.id, 'project set --id ID [--name NAME] [--wake-port PORT] [--labels LIST]');
      const body: { name?: string; wakeChannel?: string; labels?: string } = {};
      if (flags.name) body.name = String(flags.name);
      if (flags.labels !== undefined) body.labels = String(flags.labels).trim();
      if (flags['wake-port'] !== undefined) {
        const raw = String(flags['wake-port']).trim();
        body.wakeChannel = raw === '0' || raw === '-' ? '' : `http://127.0.0.1:${raw}`;
      }
      if (Object.keys(body).length === 0) throw new Error('nothing to update: pass --name, --wake-port and/or --labels');
      const p = await api('PATCH', `/api/projects/${flags.id}`, body);
      console.log(`updated ${p.id}: ${p.name} — wake → ${p.wakeChannel || '(unbound)'}`);
    }
  },
  'project list': {
    summary: 'List projects',
    usage: 'project list',
    async run(ctx) {
      for (const p of await ctx.api('GET', '/api/projects')) console.log(`${p.id}  ${p.name}  ${p.workspacePath}${p.wakeChannel ? `  wake→${p.wakeChannel}` : ''}${p.labels ? `  [${p.labels}]` : ''}`);
    }
  },
  'project refs': {
    summary: 'List git branches and worktrees of the project workspace',
    usage: 'project refs ID',
    async run(ctx) {
      const { api, rest } = ctx;
      need(!!rest[0], 'project refs ID');
      const refs = await api('GET', `/api/projects/${seg(rest[0])}/git-refs`);
      for (const b of refs.branches) console.log(`branch: ${b}`);
      for (const w of refs.worktrees) console.log(`worktree: ${w.name}  ${w.path}`);
    }
  },
  'project delete': {
    summary: 'Delete a project and all its issues/comments',
    usage: 'project delete ID [--yes]',
    async run(ctx) {
      const { api, flags, rest } = ctx;
      need(!!rest[0], 'project delete ID [--yes]');
      if (!flags.yes && !process.stdin.isTTY) { console.error('refusing to delete without confirmation: use --yes'); process.exit(1); }
      if (!flags.yes) {
        process.stderr.write(`delete project "${rest[0]}" and all its issues/comments? [y/N] `);
        const answer = await new Promise<string>(r => process.stdin.once('data', d => r(String(d).trim())));
        if (!/^y(es)?$/i.test(answer)) { console.log('aborted'); return; }
      }
      await api('DELETE', `/api/projects/${seg(rest[0])}`);
      console.log(`deleted project ${rest[0]}`);
    }
  }
};
