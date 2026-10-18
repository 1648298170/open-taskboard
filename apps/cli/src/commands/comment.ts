import { need, seg, type Command } from './registry.js';

export const commentCommands: Record<string, Command> = {
  'comment add': {
    summary: 'Add a comment to an issue',
    usage: 'comment add ID --body TEXT',
    async run(ctx) {
      const { api, flags, rest } = ctx;
      need(!!rest[0] && !!flags.body, 'comment add ID --body TEXT');
      const c = await api('POST', `/api/issues/${seg(rest[0])}/comments`, { author: flags.author ?? 'cli', body: flags.body });
      console.log(`comment ${c.id} added`);
    }
  },
  'comment edit': {
    summary: 'Edit a comment body (pending only) or move its wake status',
    usage: 'comment edit COMMENT_ID --body TEXT [--status pending|processing|processed] | --status S',
    async run(ctx) {
      const { api, flags, rest } = ctx;
      need(!!rest[0] && (!!flags.body || !!flags.status), 'comment edit COMMENT_ID --body TEXT [--status pending|processing|processed]');
      const patch: { body?: string; status?: string } = {};
      if (typeof flags.body === 'string') patch.body = flags.body;
      if (typeof flags.status === 'string') patch.status = flags.status;
      const c = await api('PATCH', `/api/comments/${seg(rest[0])}`, patch);
      console.log(`comment ${c.id} updated (status ${c.status})`);
    }
  },
  'comment rm': {
    summary: 'Delete a comment by its id',
    usage: 'comment rm COMMENT_ID',
    async run(ctx) {
      const { api, rest } = ctx;
      need(!!rest[0], 'comment rm COMMENT_ID');
      await api('DELETE', `/api/comments/${seg(rest[0])}`);
      console.log(`deleted comment #${rest[0]}`);
    }
  },
  'comment list': {
    summary: 'List comments of an issue',
    usage: 'comment list ID',
    async run(ctx) {
      const { api, rest } = ctx;
      need(!!rest[0], 'comment list ID');
      for (const c of await api('GET', `/api/issues/${seg(rest[0])}/comments`)) console.log(`${c.createdAt} [${c.status}] ${c.author}: ${c.body}`);
    }
  }
};
