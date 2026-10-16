import { lanUrls, startServer } from '@taskboard/server';
import type { Command } from './registry.js';

export const serveCommand: Command = {
  summary: 'Start the board + API',
  usage: 'serve [--host H] [--port P] [--data-dir D]',
  bare: true,
  async run(ctx) {
    const { flags } = ctx;
    const host = String(flags.host ?? '127.0.0.1');
    const port = Number(flags.port ?? 47824);
    const { url } = await startServer({
      host,
      port,
      dataDir: String(flags['data-dir'] ?? '.data')
    });
    console.log(`open-taskboard listening on ${url}`);
    if (host === '0.0.0.0' || host === '::') {
      for (const lan of lanUrls(port)) console.log(`LAN: ${lan}`);
    }
  }
};
