// Process entrypoint: env resolution, app assembly, static hosting, listen,
// and direct-run detection.
import { buildApp } from './app.js';
import { ServerOptions } from './app.js';
import { registerStatic, WEB_DIST } from './static.js';

export async function startServer(opts: ServerOptions = {}) {
  const host = opts.host ?? process.env.TASKBOARD_HOST ?? '127.0.0.1';
  const port = opts.port ?? Number(process.env.TASKBOARD_PORT ?? 47824);
  const { app, store } = await buildApp(opts);

  await registerStatic(app, {
    webDist: opts.webDist ?? process.env.TASKBOARD_WEB_DIST ?? WEB_DIST
  });

  await app.listen({ host, port });
  return { app, store, url: `http://${host}:${port}` };
}

// direct run: node dist/server.js (or tsx src/server.ts). dist/index.js is
// matched too — it is the package main, and apps/mcp spawns
// require.resolve('@taskboard/server') to auto-start the service.
const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('server.ts')
  || process.argv[1]?.replace(/\\/g, '/').endsWith('server.js')
  || process.argv[1]?.replace(/\\/g, '/').endsWith('dist/index.js');
if (invokedDirectly) {
  startServer({ dataDir: process.env.TASKBOARD_DATA_DIR || '.data' }).then(({ url }) => {
    console.log(`open-taskboard listening on ${url}`);
    console.log(`data dir: ${process.env.TASKBOARD_DATA_DIR || '.data'}/taskboard.sqlite`);
  });
}
