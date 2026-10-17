import { lanUrls, startServer } from '@taskboard/server';
import { resolveServerConfig } from '@taskboard/core';
import type { Command } from './registry.js';

export const serveCommand: Command = {
  summary: 'Start the board + API',
  usage: 'serve [--host H] [--port P] [--data-dir D]',
  bare: true,
  async run(ctx) {
    const { flags } = ctx;
    const config = resolveServerConfig(process.env);
    const host = String(flags.host ?? config.host);
    const port = Number(flags.port ?? config.port);
    const { url } = await startServer({
      host,
      port,
      dataDir: String(flags['data-dir'] ?? config.dataDir)
    });
    console.log(`open-taskboard listening on ${url}`);
    if (host === '0.0.0.0' || host === '::') {
      for (const lan of lanUrls(port)) console.log(`LAN: ${lan}`);
    }
  }
};
