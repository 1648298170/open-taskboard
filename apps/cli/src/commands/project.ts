import { need, seg, type Command } from './registry.js';

export const projectCommands: Record<string, Command> = {
  'project create': {
    summary: 'Create a project',
    usage: 'project create --name NAME [--id ID]',
    async run(ctx) {
      const { api, flags } = ctx;
      need(!!flags.name, 'project create --name NAME [--id ID]');
      const p = await api('POST', '/api/projects', { id: flags.id, name: flags.name, workspacePath: flags['workspace-path'] ?? '' });
      console.log(`created project ${p.id} (${p.name})`);
    }
  },
  'project list': {
    summary: 'List projects',
    usage: 'project list',
    async run(ctx) {
      for (const p of await ctx.api('GET', '/api/projects')) console.log(`${p.id}  ${p.name}  ${p.workspacePath}`);
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
