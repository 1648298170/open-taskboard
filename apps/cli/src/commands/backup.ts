// v0.4 P0: on-demand backup — prints the snapshot path the server wrote.
import { need, type Command } from './registry.js';

export const backupCommand: Command = {
  summary: 'Create a backup snapshot now',
  usage: 'backup',
  bare: true,
  async run(ctx) {
    need(!ctx.flags.help, 'backup');
    const res = await ctx.api('POST', '/api/backup', {}) as { path?: string };
    console.log(`backup: ${res.path}`);
  }
};
