// Process entrypoint: env resolution, app assembly, static hosting, listen,
// and direct-run detection.
import os from 'node:os';
import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { resolveServerConfig } from '@taskboard/core';
import type { Store } from '@taskboard/core';
import { buildApp } from './app.js';
import { ServerOptions } from './app.js';
import { registerStatic, WEB_DIST } from './static.js';
import { startEmbeddedWake } from './wake-embedded.js';

/** Backups kept per data dir before the oldest start getting pruned. */
const BACKUP_RETENTION = 10;

/**
 * T6-32: startup backup + retention. Snapshots the db into
 * `<dataDir>/backups/taskboard-<timestamp>.sqlite`, keeps the newest
 * BACKUP_RETENTION files, deletes older `taskboard-*.sqlite`. Every failure
 * degrades to a console.warn — a backup problem must never crash the server.
 */
function backupAndPrune(store: Store, dataDir: string): void {
  try {
    const dir = join(dataDir, 'backups');
    const path = store.backupTo(dir);
    console.log(`backup: ${path}`);
    const files = readdirSync(dir)
      .filter(f => /^taskboard-.*\.sqlite$/.test(f))
      .sort(); // taskboard-YYYYMMDD-HHMMSS sorts lexicographically = chronologically
    for (const stale of files.slice(0, Math.max(0, files.length - BACKUP_RETENTION))) {
      try { unlinkSync(join(dir, stale)); } catch { /* best effort */ }
    }
  } catch (err) {
    console.warn(`backup: failed (${(err as Error).message})`);
  }
}

/** LAN access URLs (`http://<addr>:<port>`) — non-internal IPv4 addresses, deduped. */
export function lanUrls(port: number): string[] {
  const seen = new Set<string>();
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) seen.add(iface.address);
    }
  }
  return [...seen].map(addr => `http://${addr}:${port}`);
}

export async function startServer(opts: ServerOptions = {}) {
  // One env resolution for the whole process; tests inject opts.env so the
  // embedded wake gate and the backup flag can be exercised without mutating
  // process.env.
  const env = opts.env ?? process.env;
  const config = resolveServerConfig(env);
  const host = opts.host ?? config.host;
  const port = opts.port ?? config.port;
  const dataDir = opts.dataDir ?? config.dataDir;
  const { app, store } = await buildApp({ ...opts, dataDir });

  // Phase 2: embed the wake engine in the server process. It is started HERE,
  // not in buildApp, so app-only unit tests never create a background timer.
  // The host sidecar (`taskboard watch`) keeps the file lock / TUI / headless
  // channels; this engine only delivers bound-session prompts and polls the
  // pending set as a safety net.
  const wake = await startEmbeddedWake({ store, env, ...opts.wake });
  // onClose runs on app.close() (tests, graceful shutdown). Must be registered
  // before listen — Fastify rejects addHook once the instance has started.
  app.addHook('onClose', async () => { await wake.stop(); });

  try {
    await registerStatic(app, {
      webDist: opts.webDist ?? env.TASKBOARD_WEB_DIST ?? WEB_DIST
    });

    await app.listen({ host, port });
  } catch (err) {
    await wake.stop();
    throw err;
  }

  // T6-32: post-listen startup backup. On by default; TASKBOARD_BACKUPS=0
  // disables. dataDir mirrors the Store's dir (explicit opt → config).
  if (config.backupsEnabled) backupAndPrune(store, dataDir);
  return { app, store, wake, url: `http://${host}:${port}` };
}

// direct run: node dist/server.js (or tsx src/server.ts). dist/index.js is
// matched too — it is the package main, and apps/mcp spawns
// require.resolve('@taskboard/server') to auto-start the service.
const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('server.ts')
  || process.argv[1]?.replace(/\\/g, '/').endsWith('server.js')
  || process.argv[1]?.replace(/\\/g, '/').endsWith('dist/index.js');
if (invokedDirectly) {
  startServer().then(({ url }) => {
    console.log(`open-taskboard listening on ${url}`);
    const config = resolveServerConfig(process.env);
    console.log(`data dir: ${config.dataDir}/taskboard.sqlite`);
    if (config.host === '0.0.0.0' || config.host === '::') {
      for (const lan of lanUrls(config.port)) {
        console.log(`LAN: ${lan}`);
      }
    }
  });
}
