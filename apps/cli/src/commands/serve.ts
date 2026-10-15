import { startServer } from '@taskboard/server';
import type { Command } from './registry.js';

export const serveCommand: Command = {
  summary: 'Start the board + API',
  usage: 'serve [--host H] [--port P] [--data-dir D]',
  bare: true,
  async run(ctx) {
    const { flags } = ctx;
    const { url } = await startServer({
      host: String(flags.host ?? '127.0.0.1'),
      port: Number(flags.port ?? 47824),
      dataDir: String(flags['data-dir'] ?? '.data')
    });
    console.log(`open-taskboard listening on ${url}`);
  }
};
